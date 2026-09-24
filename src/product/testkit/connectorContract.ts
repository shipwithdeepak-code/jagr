import { describe, expect, it } from 'vitest';
import type { ISO } from '../types';
import type { HttpClient, HttpRequest, HttpResponse } from '../ports/http';
import type { Connection } from '../ports/persistence';
import type { SecretPayload } from '../ports/secrets';
import { manualClock } from '../ports/clock';
import type { RegisteredSource, Role, TimeWindow } from '../roles/types';
import { ProviderUnavailableError } from '../integrations/types';
import type { ConnectorDescriptor } from '../integrations/connectors/types';
import { checkConnector, connectorFactory } from '../integrations/connectors/runtime';
import { ConnectorAuthError, ConnectorRateLimited } from '../integrations/connectors/errors';
import { roleSourceContract } from './roleContract';

/**
 * The connector contract. Every real connector runs it against recorded provider responses:
 *
 *   - it passes the role-source contract (provenance, window, failures throw)
 *   - it maps the recorded data into at least the expected number of records per role
 *   - every record is `connected` provenance for its own connection, with a deep link
 *   - it only calls its declared hosts, over https
 *   - 401/403 → ConnectorAuthError, 429 → ConnectorRateLimited, 5xx / network / timeout / garbage → unavailable/error;
 *     a failed read never becomes an empty answer
 *   - no credential value appears in any record, error message or check result; no email address in records
 *   - two connections of the same connector never see each other's credential
 *   - check() reports connected / needs_reconnect / error without throwing
 */

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw text instead of JSON (e.g. a garbage body). */
  text?: string;
}

export interface Recorded {
  url: string;
  init?: HttpRequest;
}

/** A scripted HttpClient: answers from `route`, records every call. Unrouted calls answer 404. */
export function scriptedHttp(route: (url: URL, init?: HttpRequest) => Reply | undefined): { http: HttpClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init });
    const r = route(new URL(url), init) ?? { status: 404, body: { error: 'not found' } };
    return response(r);
  };
  return { http, calls };
}

export function response(r: Reply): HttpResponse {
  const status = r.status ?? 200;
  const text = r.text ?? JSON.stringify(r.body ?? null);
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

export interface ConnectorContractCase<C> {
  name: string;
  descriptor: ConnectorDescriptor<C>;
  /** A valid connection (config) and its credential. */
  connection: Connection;
  secret: SecretPayload;
  /** A second, different credential for the isolation check. */
  otherSecret: SecretPayload;
  /** Recorded provider responses. Must include at least one record after `window.end` (to prove it is excluded). */
  route: (url: URL, init?: HttpRequest) => Reply | undefined;
  window: TimeWindow;
  /** Minimum number of records the recording must map to, per role. */
  expectRecords: Partial<Record<Exclude<Role, 'conversations' | 'context'>, number>>;
  /** Configs the connector must refuse (e.g. a host outside the provider's domain). */
  invalidConfigs: Record<string, unknown>[];
}

const secretValues = (s: SecretPayload): string[] =>
  (s.kind === 'api_key' ? Object.values(s.fields) : s.kind === 'oauth' ? [s.accessToken, s.refreshToken ?? ''] : [s.installationId]).filter((v) => v.length >= 6);

async function readAll(src: RegisteredSource, window: TimeWindow) {
  const out: { role: Role; records: unknown[] }[] = [];
  if (src.metrics) {
    const series = [];
    for (const d of src.metrics.metricDefinitions()) {
      const s = await src.metrics.getSeries({ metric: d.key, window });
      if (s) series.push(s);
      for (const dim of src.metrics.listDimensions(d.key)) series.push(...(await src.metrics.getBreakdown({ metric: d.key, window, dimension: dim })).map((x) => x.series));
    }
    out.push({ role: 'metrics', records: series });
  }
  if (src.changes) out.push({ role: 'changes', records: await src.changes.getChanges({ window }) });
  if (src.work_items) out.push({ role: 'work_items', records: await src.work_items.getWorkItems({ window }) });
  if (src.feedback) out.push({ role: 'feedback', records: await src.feedback.getFeedback({ window }) });
  return out;
}

function roleCalls(src: RegisteredSource, window: TimeWindow): Promise<unknown>[] {
  const calls: Promise<unknown>[] = [];
  if (src.metrics) for (const d of src.metrics.metricDefinitions()) calls.push(src.metrics.getSeries({ metric: d.key, window }));
  if (src.changes) calls.push(src.changes.getChanges({ window }));
  if (src.work_items) calls.push(src.work_items.getWorkItems({ window }));
  if (src.feedback) calls.push(src.feedback.getFeedback({ window }));
  return calls;
}

export function connectorContract<C>(c: ConnectorContractCase<C>) {
  const clock = () => manualClock(c.window.end as ISO);
  const build = (http: HttpClient, secret = c.secret, connection = c.connection) => connectorFactory(c.descriptor)(connection, { secret, http, clock: clock() });
  const failing = (reply: Reply | 'throw' | 'timeout'): HttpClient => async () => {
    if (reply === 'throw') throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
    if (reply === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return response(reply);
  };

  roleSourceContract({
    name: c.name,
    make: () => build(scriptedHttp(c.route).http),
    window: c.window,
    broken: (state) => build(failing(state === 'unavailable' ? { status: 503, body: {} } : { status: 400, body: {} })),
  });

  describe(`connector contract: ${c.name}`, () => {
    it('maps the recorded responses into records, all with connected provenance for this connection and a link', async () => {
      const src = build(scriptedHttp(c.route).http);
      expect(src.id).toBe(c.descriptor.source);
      const all = await readAll(src, c.window);
      for (const [role, min] of Object.entries(c.expectRecords)) {
        const got = all.find((x) => x.role === role)?.records.length ?? 0;
        expect(got, `${role} records`).toBeGreaterThanOrEqual(min!);
      }
      for (const { records } of all) {
        for (const r of records as { provenance: { mode: string; connectionId: string; provider: string; url?: string } }[]) {
          expect(r.provenance.mode).toBe('connected');
          expect(r.provenance.connectionId).toBe(c.connection.id);
          expect(r.provenance.provider).toBe(c.descriptor.id);
          expect(r.provenance.url, 'deep link').toMatch(/^https:\/\//);
        }
      }
    });

    it('calls only its declared hosts, over https', async () => {
      const { http, calls } = scriptedHttp(c.route);
      await readAll(build(http), c.window);
      expect(calls.length).toBeGreaterThan(0);
      const cfg = c.descriptor.config.parse(c.connection.config);
      const hosts = c.descriptor.hosts(cfg);
      for (const call of calls) {
        const u = new URL(call.url);
        expect(u.protocol).toBe('https:');
        expect(hosts).toContain(u.hostname);
      }
    });

    it('refuses invalid configuration before any request', async () => {
      for (const config of c.invalidConfigs) {
        const { http, calls } = scriptedHttp(c.route);
        expect(() => build(http, c.secret, { ...c.connection, config })).toThrow();
        const check = await checkConnector(c.descriptor, { ...c.connection, config }, { secret: c.secret, http, clock: clock() });
        expect(check.state).toBe('error');
        expect(calls).toHaveLength(0);
      }
    });

    it('classifies provider failures — and a failed read is never an empty answer', async () => {
      const cases: [Reply | 'throw' | 'timeout', (e: unknown) => void][] = [
        [{ status: 401, body: {} }, (e) => expect(e).toBeInstanceOf(ConnectorAuthError)],
        [{ status: 403, body: {} }, (e) => expect(e).toBeInstanceOf(ConnectorAuthError)],
        [{ status: 429, body: {}, headers: { 'retry-after': '30' } }, (e) => expect(e).toBeInstanceOf(ConnectorRateLimited)],
        [{ status: 500, body: {} }, (e) => expect((e as ProviderUnavailableError).state).toBe('unavailable')],
        ['throw', (e) => expect((e as ProviderUnavailableError).state).toBe('unavailable')],
        ['timeout', (e) => expect((e as ProviderUnavailableError).state).toBe('unavailable')],
        [{ status: 200, text: '<html>oops</html>' }, (e) => expect(e).toBeInstanceOf(ProviderUnavailableError)],
      ];
      for (const [reply, assert] of cases) {
        const calls = roleCalls(build(failing(reply)), c.window);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          const err = await call.then(
            () => undefined,
            (e) => e,
          );
          expect(err, `a ${typeof reply === 'string' ? reply : reply.status} must not produce an answer`).toBeInstanceOf(ProviderUnavailableError);
          assert(err);
          for (const v of secretValues(c.secret)) expect((err as Error).message).not.toContain(v);
        }
      }
    });

    it('never leaks a credential or an email address into records or check results', async () => {
      const all = await readAll(build(scriptedHttp(c.route).http), c.window);
      const text = JSON.stringify(all);
      for (const v of secretValues(c.secret)) expect(text).not.toContain(v);
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      const check = await checkConnector(c.descriptor, c.connection, { secret: c.secret, http: scriptedHttp(c.route).http, clock: clock() });
      for (const v of secretValues(c.secret)) expect(JSON.stringify(check)).not.toContain(v);
      expect(check.account ?? '').not.toMatch(/@/);
    });

    it('isolates connections: each request carries only its own connection’s credential', async () => {
      const { http, calls } = scriptedHttp(c.route);
      await readAll(build(http, c.secret, c.connection), c.window);
      const mine = calls.splice(0);
      await readAll(build(http, c.otherSecret, { ...c.connection, id: `${c.connection.id}-other` }), c.window);
      const theirs = calls.splice(0);
      const carried = (rs: Recorded[]) => JSON.stringify(rs.map((r) => [r.url, r.init?.headers, r.init?.body]));
      const a = carried(mine);
      const b = carried(theirs);
      for (const v of secretValues(c.otherSecret)) expect(a).not.toContain(v);
      for (const v of secretValues(c.secret)) expect(b).not.toContain(v);
    });

    it('check() reports connected, needs_reconnect and unavailable without throwing', async () => {
      const ok = await checkConnector(c.descriptor, c.connection, { secret: c.secret, http: scriptedHttp(c.route).http, clock: clock() });
      expect(ok.state).toBe('connected');
      expect((await checkConnector(c.descriptor, c.connection, { secret: c.secret, http: failing({ status: 401, body: {} }), clock: clock() })).state).toBe('needs_reconnect');
      expect((await checkConnector(c.descriptor, c.connection, { secret: c.secret, http: failing('throw'), clock: clock() })).state).toBe('unavailable');
      expect((await checkConnector(c.descriptor, c.connection, { secret: undefined, http: failing('throw'), clock: clock() })).state).toBe('error');
    });
  });
}
