import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, watchFromTemplate } from './catalog';
import { createRegistry, defaultConnections } from './integrations/adapters';
import { defaultWorld, t } from './integrations/world';
import { ProviderUnavailableError } from './integrations/types';
import { SourceRegistry } from './roles/registry';
import type { ChangeRecord, RegisteredSource } from './roles/types';
import type { MonitoringResult, SourceConnection, Watch, WatchInvestigation } from './types';
import { runMonitoring } from './engine/monitor';

/**
 * GitHub change detection (connected change source): a failed deployment to a watched environment is a
 * finding (MEDIUM); successful deployments and releases are brief context only; the cause stays unknown.
 */

const world = defaultWorld();

function deploy(n: number, hhmm: string, status: ChangeRecord['status'], sha: string, env = 'Production'): ChangeRecord {
  const at = t(hhmm);
  const id = `acme/web#deployment-${n}`;
  return {
    id: `github-deploy-acme/web-${n}`,
    source: 'github',
    kind: 'deploy',
    timing: status === 'in_progress' ? 'reported' : 'actual',
    title: `Deploy ${sha} to ${env} (acme/web)`,
    at,
    version: sha,
    status,
    ref: { provider: 'github', kind: 'release', id },
    provenance: { source: 'github', provider: 'github', connectionId: 'conn-github', mode: 'connected', externalId: id, url: `https://github.com/acme/web/commit/${sha}`, observedAt: at, fetchedAt: at },
  };
}

function release(n: number, hhmm: string, tag: string): ChangeRecord {
  const at = t(hhmm);
  const id = `acme/web#release-${n}`;
  return {
    id: `github-release-acme/web-${n}`,
    source: 'github',
    kind: 'release',
    timing: 'reported',
    title: `${tag} (acme/web)`,
    at,
    version: tag,
    ref: { provider: 'github', kind: 'release', id },
    provenance: { source: 'github', provider: 'github', connectionId: 'conn-github', mode: 'connected', externalId: id, url: `https://github.com/acme/web/releases/tag/${tag}`, observedAt: at, fetchedAt: at },
  };
}

const githubConnection: SourceConnection = { provider: 'github', state: 'connected', detail: 'GitHub · 1 repository · Production', updatedAt: world.start };

/** A connected GitHub change source that answers from `records` (or is unreachable). */
function github(records: ChangeRecord[] | 'down', calls?: { n: number }): RegisteredSource {
  return {
    id: 'github',
    connection: githubConnection,
    changes: {
      tracksRollout: false,
      async getChanges({ window }) {
        if (calls) calls.n++;
        if (records === 'down') throw new ProviderUnavailableError('github', 'unavailable', 'GitHub could not be reached.');
        return records.filter((r) => r.at >= window.start && r.at <= window.end);
      },
    },
  };
}

const githubWatch = (): Watch => watchFromTemplate('w-gh', 'github_changes', { sources: ['github'] }, world.start);

async function runGithub(records: ChangeRecord[] | 'down', calls?: { n: number }): Promise<MonitoringResult> {
  return runMonitoring({
    world,
    registry: new SourceRegistry([github(records, calls)]),
    watches: [githubWatch()],
    connections: [githubConnection, { provider: 'email', state: 'simulated', detail: 'Simulated outbox', updatedAt: world.start }],
    brief: defaultBriefSchedule(),
  });
}

const deploymentInvs = (r: MonitoringResult) => r.investigations.filter((i) => !!i.deployment);
/** Every piece of text Jagr wrote for an investigation. */
const textOf = (i: WatchInvestigation) => [i.title, i.summary, i.likelyExplanation, i.uncertainty, i.attentionReason, i.recommendedNextStep, ...i.observed, ...i.inferred, ...i.unknowns, ...i.trace.flatMap((s) => [s.title, s.detail ?? ''])].join('\n');

describe('GitHub production changes template', () => {
  it('watches only GitHub, and only the changes signal', () => {
    const w = githubWatch();
    expect(w.sources).toEqual(['github']);
    expect(w.signals).toEqual([{ key: 'changes', area: undefined }]);
  });
});

describe('GitHub change detection', () => {
  it('a failed deployment opens exactly one MEDIUM investigation, with only facts from GitHub and the cause unknown', async () => {
    const r = await runGithub([deploy(1, '20:00', 'failed', 'abc1234')]);
    const invs = deploymentInvs(r);
    expect(invs).toHaveLength(1);
    const inv = invs[0];
    expect(inv.attention).toBe('MEDIUM');
    expect(inv.status).toBe('CONFIRMED');
    expect(inv.title).toBe('Deployment failed: Deploy abc1234 to Production (acme/web)');
    // Evidence: one fact, from GitHub, linking to the record.
    expect(inv.evidence).toHaveLength(1);
    expect(inv.evidence[0].provider).toBe('github');
    expect(inv.evidence[0].statement).toBe('GitHub: Deploy abc1234 to Production (acme/web) — reported as failed at 20:00.');
    expect(inv.evidence[0].link?.externalUrl).toBe('https://github.com/acme/web/commit/abc1234');
    expect(inv.inferred).toEqual([]);
    expect(inv.hypotheses).toEqual([]);
    expect(inv.unknowns.some((u) => /Why the deployment failed/.test(u))).toBe(true);
    expect(inv.uncertainty).toMatch(/^Cause not established/);
    // MEDIUM: morning brief, no email.
    expect(r.emails).toHaveLength(0);
    expect(r.briefs.at(-1)!.items.map((i) => i.investigationId)).toContain(inv.id);
    expect(r.log.some((l) => /1 failed deployment reported/.test(l.outcome))).toBe(true);
  });

  it('a successful deployment is not a finding — it is brief context', async () => {
    const r = await runGithub([deploy(1, '20:00', 'success', 'abc1234')]);
    expect(r.investigations).toHaveLength(0);
    expect(r.briefs.at(-1)!.shipped).toEqual([expect.objectContaining({ title: 'Deploy abc1234 to Production (acme/web)', kind: 'deploy' })]);
  });

  it('a published release is context only', async () => {
    const r = await runGithub([release(7, '21:00', 'v2.4.0')]);
    expect(r.investigations).toHaveLength(0);
    expect(r.emails).toHaveLength(0);
    expect(r.briefs.at(-1)!.shipped).toEqual([expect.objectContaining({ title: 'v2.4.0 (acme/web)', kind: 'release', timing: 'reported' })]);
  });

  it('the same failed deployment, seen on every run, never opens a second investigation', async () => {
    const calls = { n: 0 };
    const r = await runGithub([deploy(1, '20:00', 'failed', 'abc1234')], calls);
    expect(calls.n).toBeGreaterThan(5); // re-read on many scheduled runs within the 6-hour lookback
    expect(deploymentInvs(r)).toHaveLength(1);
    // A different failed deployment is a different investigation.
    const two = await runGithub([deploy(1, '20:00', 'failed', 'abc1234'), deploy(2, '23:00', 'failed', 'def5678')]);
    expect(deploymentInvs(two).map((i) => i.deployment!.recordId).sort()).toEqual(['github-deploy-acme/web-1', 'github-deploy-acme/web-2']);
  });

  it('a later successful deployment closes the deployment failure — without claiming product recovery', async () => {
    const r = await runGithub([deploy(1, '20:00', 'failed', 'abc1234'), deploy(2, '22:00', 'success', 'def5678')]);
    const [inv] = deploymentInvs(r);
    expect(inv.status).toBe('RESOLVED');
    const close = inv.trace.find((s) => s.title === 'Deployment failure resolved by a subsequent successful deployment')!;
    expect(close.detail).toMatch(/closes the deployment failure only — it is not evidence that product impact is resolved/);
    expect(inv.summary).toMatch(/product impact not assessed/);
    expect(inv.unknowns.some((u) => /Whether any product or system impact is resolved/.test(u) && /does not infer that it fixed the application or caused any metric recovery/.test(u))).toBe(true);
    // Nowhere does Jagr say the application was fixed, or that something recovered, except to deny inferring it.
    const text = textOf(inv);
    for (const line of text.split('\n').filter((l) => /\b(fixed|recover(y|ed)|restored)\b/i.test(l))) expect(line).toMatch(/not|does not infer/i);
  });

  it('a success on a different target does not close the failure', async () => {
    const r = await runGithub([deploy(1, '20:00', 'failed', 'abc1234', 'Production'), deploy(2, '22:00', 'success', 'def5678', 'Preview')]);
    expect(deploymentInvs(r)[0].status).toBe('CONFIRMED');
  });

  it('GitHub unavailable is an explicit source gap — never "nothing changed"', async () => {
    const r = await runGithub('down');
    expect(r.investigations).toHaveLength(0);
    const runs = r.log.filter((l) => l.type === 'watch_run');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((l) => /GitHub unavailable/.test(l.outcome))).toBe(true);
  });

  it('existing correlation can raise attention: another watched source degrading soon after the failure → HIGH (timing, not cause)', async () => {
    const sample = createRegistry(world, defaultConnections()).registry;
    const registry = new SourceRegistry([...sample.sources(), github([deploy(1, '18:50', 'failed', 'abc1234')])]);
    const checkout = watchFromTemplate('w-checkout', 'checkout_health', {}, world.start);
    const r = await runMonitoring({ world, registry, watches: [checkout, githubWatch()], connections: [...defaultConnections(), githubConnection], brief: defaultBriefSchedule() });
    const [inv] = deploymentInvs(r);
    expect(inv.attention).toBe('HIGH');
    expect(inv.attentionReason).toMatch(/began \d+ min after this failed deployment — a timing correlation in another watched source, not a cause/);
    expect(inv.unknowns.some((u) => /timing alone does not establish it/.test(u))).toBe(true);
  });
});
