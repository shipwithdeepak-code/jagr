import { describe, expect, it } from 'vitest';
import type { Connection, Workspace } from '../../ports/persistence';
import type { NotificationMessage } from '../../ports/notify';
import type { HttpClient } from '../../ports/http';
import { manualClock } from '../../ports/clock';
import { createMemoryPersistence, createMemorySecretStore } from '../../ports/memory';
import { deliver } from '../../app/notifications';
import { response, scriptedHttp } from '../../testkit/connectorContract';
import { escapeMrkdwn, renderSlack, slackChannel, slackChannelFactory } from './slack';
import { CHANNELS } from './index';

const NOW = '2026-09-25T06:00:00.000Z';
const TOKEN = 'xoxb-not-a-real-token-for-tests';

const approval: NotificationMessage = {
  kind: 'approval_requested',
  workspaceId: 'ws-1',
  dedupeKey: 'alert:e1',
  title: 'Checkout conversion declined <script>&',
  attention: 'HIGH',
  summary: 'Checkout conversion −25% since 02:00, 15 min after deploy v2.3.0. Customer maria@example.org wrote in.',
  observed: ['Amplitude: Checkout conversion is 22.5% vs 30% baseline (−25%) since 02:00.', 'GitHub: deploy v2.3.0 at 01:45 (actual time).'],
  inferred: ['The degradation began 15 minutes after deploy v2.3.0 — a temporal association.'],
  unknown: ['Whether deploy v2.3.0 is responsible — timing is not causation.'],
  links: [
    { label: 'Open investigation in Jagr', href: 'https://jagr.acme.test/investigations/w/wi-1' },
    { label: 'Not https', href: 'javascript:alert(1)' },
  ],
  approval: { actionId: 'act-1', risk: 'HIGH', what: 'Pause the staged rollout of v2.3.0' },
};

describe('Slack rendering (Block Kit)', () => {
  it('renders the domain message — snapshot', () => {
    expect(renderSlack(approval)).toMatchSnapshot();
  });

  it('escapes mrkdwn, keeps only https link buttons, and has no interactive actions besides links', () => {
    const { blocks } = renderSlack(approval);
    const json = JSON.stringify(blocks);
    // mrkdwn fields are escaped; the header is plain_text, which Slack never interprets.
    const mrkdwn = JSON.stringify(blocks.flatMap((b) => [(b as { text?: { type: string; text: string } }).text, ...((b as { elements?: { type: string; text: string }[] }).elements ?? [])]).filter((t) => t?.type === 'mrkdwn'));
    expect(mrkdwn).not.toMatch(/<script>/);
    expect((blocks[0] as { text: { type: string } }).text.type).toBe('plain_text');
    expect(escapeMrkdwn('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    const actions = blocks.filter((b) => b.type === 'actions') as { elements: { type: string; url?: string }[] }[];
    const elements = actions.flatMap((a) => a.elements);
    expect(elements).toHaveLength(1);
    expect(elements.every((e) => e.type === 'button' && /^https:\/\//.test(e.url ?? ''))).toBe(true);
    expect(json).toMatch(/Decide in Jagr — nothing is approved from Slack/);
  });

  it('carries no personal data', () => {
    expect(JSON.stringify(renderSlack(approval))).not.toContain('maria@example.org');
  });
});

describe('Slack delivery', () => {
  it('posts to chat.postMessage with the bot token and the configured channel', async () => {
    const { http, calls } = scriptedHttp((u) => (u.pathname === '/api/chat.postMessage' ? { body: { ok: true, ts: '1727244000.000100' } } : undefined));
    const r = await slackChannel(TOKEN, http, manualClock(NOW)).send(approval, { address: 'C0123456789' });
    expect(r).toMatchObject({ status: 'delivered', externalId: '1727244000.000100' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ channel: 'C0123456789', unfurl_links: false });
    expect(String(calls[0].init?.body)).not.toContain(TOKEN);
  });

  it('never throws: API errors, rate limits and outages become failed receipts without the token', async () => {
    const cases: HttpClient[] = [
      async () => response({ body: { ok: false, error: 'channel_not_found' } }),
      async () => response({ status: 429, body: {}, headers: { 'retry-after': '30' } }),
      async () => response({ status: 500, body: {} }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const http of cases) {
      const r = await slackChannel(TOKEN, http, manualClock(NOW)).send(approval, { address: 'C0123456789' });
      expect(r.status).toBe('failed');
      expect(r.detail ?? '').not.toContain(TOKEN);
    }
    const nf = await slackChannel(TOKEN, cases[0], manualClock(NOW)).send(approval, { address: 'C0123456789' });
    expect(nf.detail).toMatch(/channel_not_found/);
  });

  it('the factory validates config and requires a token', () => {
    const base: Connection = { id: 'owner-slack', workspaceId: 'ws-1', source: 'slack', provider: 'slack', roles: [], authKind: 'owner_env', state: 'connected', detail: '', config: { channel: 'C0123456789' }, updatedAt: NOW };
    const ctx = { http: scriptedHttp(() => undefined).http, clock: manualClock(NOW) };
    expect(() => slackChannelFactory({ ...base, config: { channel: '#general' } }, { ...ctx, secret: { kind: 'api_key', fields: { botToken: TOKEN } } })).toThrow(/channel id/);
    expect(() => slackChannelFactory(base, { ...ctx, secret: undefined })).toThrow(/bot token/);
    expect(slackChannelFactory(base, { ...ctx, secret: { kind: 'api_key', fields: { botToken: TOKEN } } }).target).toEqual({ address: 'C0123456789' });
  });
});

describe('delivery service', () => {
  async function setup(state: Connection['state'] = 'connected', config: Record<string, unknown> = { channel: 'C0123456789' }) {
    const { repos } = createMemoryPersistence();
    const secrets = createMemorySecretStore();
    const ws: Workspace = { id: 'ws-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 };
    await repos.workspaces.create(ws);
    const secretRef = await secrets.put({ workspaceId: 'ws-1', connectionId: 'owner-slack' }, { kind: 'api_key', fields: { botToken: TOKEN } });
    await repos.connections.save('ws-1', { id: 'owner-slack', workspaceId: 'ws-1', source: 'slack', provider: 'slack', roles: [], authKind: 'owner_env', state, detail: '', config, secretRef, updatedAt: NOW });
    return { repos, secrets, ws };
  }

  it('delivers once per message (idempotent) and logs it without addresses or tokens', async () => {
    const { repos, secrets, ws } = await setup();
    const { http, calls } = scriptedHttp(() => ({ body: { ok: true, ts: '1.2' } }));
    const deps = { repos, secrets, http, clock: manualClock(NOW), channels: CHANNELS };
    expect(await deliver(deps, ws, [approval])).toEqual({ delivered: 1, duplicates: 0, failed: 0 });
    expect(await deliver(deps, ws, [approval])).toEqual({ delivered: 0, duplicates: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    const log = await repos.notifications.list('ws-1');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ channel: 'slack', status: 'delivered', dedupeKey: 'owner-slack:alert:e1' });
    expect(JSON.stringify(log)).not.toMatch(/xoxb-|maria@/);
  });

  it('a failed delivery is logged and tried again next time; it never throws', async () => {
    const { repos, secrets, ws } = await setup();
    let up = false;
    const http: HttpClient = async () => (up ? response({ body: { ok: true, ts: '9.9' } }) : response({ status: 503, body: {} }));
    const deps = { repos, secrets, http, clock: manualClock(NOW), channels: CHANNELS };
    expect(await deliver(deps, ws, [approval])).toEqual({ delivered: 0, duplicates: 0, failed: 1 });
    up = true;
    expect(await deliver(deps, ws, [approval])).toEqual({ delivered: 1, duplicates: 0, failed: 0 });
    const log = await repos.notifications.list('ws-1');
    expect(log.map((n) => n.status).sort()).toEqual(['delivered', 'failed']);
  });

  it('a misconfigured channel is a failed delivery, not an exception; disconnected channels are skipped', async () => {
    const bad = await setup('connected', { channel: 'general' });
    const deps = { repos: bad.repos, secrets: bad.secrets, http: scriptedHttp(() => undefined).http, clock: manualClock(NOW), channels: CHANNELS };
    expect(await deliver(deps, bad.ws, [approval])).toEqual({ delivered: 0, duplicates: 0, failed: 1 });
    expect((await bad.repos.notifications.list('ws-1'))[0].detail).toMatch(/configuration is invalid/);
    const off = await setup('not_configured');
    const { http, calls } = scriptedHttp(() => ({ body: { ok: true } }));
    expect(await deliver({ repos: off.repos, secrets: off.secrets, http, clock: manualClock(NOW), channels: CHANNELS }, off.ws, [approval])).toEqual({ delivered: 0, duplicates: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
