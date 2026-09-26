import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, watchFromTemplate } from './catalog';
import { createRegistry, defaultConnections } from './integrations/adapters';
import { defaultWorld, t } from './integrations/world';
import { ProviderUnavailableError } from './integrations/types';
import { SourceRegistry } from './roles/registry';
import type { ChangeRecord, RegisteredSource } from './roles/types';
import type { MonitoringResult, MorningBriefDoc, SourceConnection, Watch, WatchInvestigation } from './types';
import { changeTarget, runMonitoring } from './engine/monitor';
import { briefMessage } from './app/notifications';
import { renderSlack } from './integrations/channels/slack';

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

/** A deployment as the connector now reports it: a structured target, and the ref (branch or tag) as its version. */
function refDeploy(n: number, hhmm: string, status: ChangeRecord['status'], sha: string, ref: string, env = 'Production'): ChangeRecord {
  return { ...deploy(n, hhmm, status, sha, env), version: ref, target: `acme/web:${env.toLowerCase()}` };
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
    // Nothing was read, so nothing is counted, and no signal check is claimed.
    expect(runs.some((l) => /deployments?, \d+ releases?|within normal range/.test(l.outcome))).toBe(false);
  });

  it('a quiet changes-only run says what GitHub returned — never "All signals within normal range"', async () => {
    const quiet = (await runGithub([])).log.filter((l) => l.type === 'watch_run');
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((l) => l.outcome === 'GitHub: 0 deployments, 0 releases in the last 6h')).toBe(true);
    const busy = (await runGithub([deploy(1, '20:00', 'success', 'abc1234'), release(7, '20:30', 'v2.4.0')])).log.filter((l) => l.type === 'watch_run' && l.scheduledAt >= t('21:00') && l.scheduledAt <= t('23:00'));
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((l) => l.outcome === 'GitHub: 1 deployment, 1 release in the last 6h')).toBe(true);
    const failed = (await runGithub([deploy(1, '20:00', 'failed', 'abc1234')])).log.find((l) => l.type === 'watch_run' && l.scheduledAt >= t('20:30'))!;
    expect(failed.outcome).toBe('GitHub: 1 deployment, 0 releases in the last 6h · 1 failed deployment reported');
  });

  it('a watch with metric signals keeps its existing wording', async () => {
    const sample = createRegistry(world, defaultConnections()).registry;
    const checkout = watchFromTemplate('w-checkout', 'checkout_health', {}, world.start);
    const r = await runMonitoring({ world, registry: sample, watches: [checkout], connections: defaultConnections(), brief: defaultBriefSchedule() });
    const runs = r.log.filter((l) => l.type === 'watch_run');
    expect(runs.some((l) => /^All signals within normal range/.test(l.outcome))).toBe(true);
    expect(runs.some((l) => /in the last 6h/.test(l.outcome))).toBe(false);
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

describe('deployment target (structured, not parsed from the title)', () => {
  it('the target is the record’s own; records without one fall back to the title without the version', () => {
    expect(changeTarget(refDeploy(1, '20:00', 'failed', 'abc1234', 'main'))).toBe('acme/web:production');
    expect(changeTarget(deploy(1, '20:00', 'failed', 'abc1234'))).toBe('Deploy  to Production (acme/web)');
  });

  it('branch ref: a later successful deployment on the same repository and environment closes the failure', async () => {
    const r = await runGithub([refDeploy(1, '20:00', 'failed', 'abc1234', 'main'), refDeploy(2, '22:00', 'success', 'def5678', 'main')]);
    const [inv] = deploymentInvs(r);
    expect(inv.deployment!.target).toBe('acme/web:production');
    expect(inv.status).toBe('RESOLVED');
    expect(inv.attention).toBe('MEDIUM');
    expect(inv.trace.some((s) => s.title === 'Deployment failure resolved by a subsequent successful deployment' && /not evidence that product impact is resolved/.test(s.detail ?? ''))).toBe(true);
  });

  it('tag ref: same result; a success on another environment still does not close it', async () => {
    const closed = await runGithub([refDeploy(1, '20:00', 'failed', 'abc1234', 'v2.4.0'), refDeploy(2, '22:00', 'success', 'def5678', 'v2.4.1')]);
    expect(deploymentInvs(closed)[0].status).toBe('RESOLVED');
    const open = await runGithub([refDeploy(1, '20:00', 'failed', 'abc1234', 'main'), refDeploy(2, '22:00', 'success', 'def5678', 'main', 'Preview')]);
    expect(deploymentInvs(open)[0].status).toBe('CONFIRMED');
  });

  it('a failure recorded before targets existed still closes on a success that now carries one', async () => {
    const r = await runGithub([deploy(1, '20:00', 'failed', 'abc1234'), { ...deploy(2, '22:00', 'success', 'def5678'), target: 'acme/web:production' }]);
    expect(deploymentInvs(r)[0].status).toBe('RESOLVED');
  });
});

describe('Slack brief: shipped changes as context', () => {
  async function slackBrief(records: ChangeRecord[], over: Partial<MorningBriefDoc> = {}) {
    const r = await runGithub(records);
    const brief = { ...r.briefs.at(-1)!, ...over };
    const message = briefMessage('ws-1', brief, { investigations: r.investigations, watches: [githubWatch()] });
    const blocks = renderSlack(message).blocks;
    const sectionText = blocks.filter((b) => b.type === 'section').map((b) => (b.text as { text: string }).text);
    return { brief, message, sectionText, shippedSection: sectionText.find((t) => t.startsWith('*Shipped')) };
  }

  it('successful deployments and releases appear under "Shipped (context, not findings)" — with no cause claimed', async () => {
    const { shippedSection, message } = await slackBrief([deploy(1, '20:00', 'success', 'abc1234'), release(7, '21:00', 'v2.4.0')]);
    expect(shippedSection).toBe('*Shipped (context, not findings)*\n• 20:00 UTC · Deploy abc1234 to Production (acme/web) — deployment succeeded\n• 21:00 UTC · v2.4.0 (acme/web) — release published');
    expect(shippedSection).not.toMatch(/caus|fix|recover|because/i);
    // Context, not items: no finding is listed for them.
    expect(message.observed).toEqual([]);
  });

  it('a change source that could not be read is named — never "nothing shipped"', async () => {
    // As the server's brief job records it when GitHub cannot be read (server/githubChanges.test.ts).
    const { shippedSection } = await slackBrief([], { shipped: undefined, shippedUnavailable: ['github'] });
    expect(shippedSection).toBe('*Shipped (context, not findings)*\nCould not read changes from GitHub — this list may be incomplete.');
  });

  it('nothing shipped and nothing unreadable: no shipped section at all', async () => {
    const { message, shippedSection } = await slackBrief([]);
    expect(message.shipped).toBeUndefined();
    expect(shippedSection).toBeUndefined();
  });

  it('a failed deployment stays a finding (Items), separate from the shipped context', async () => {
    const { message, shippedSection, sectionText } = await slackBrief([deploy(1, '20:00', 'failed', 'abc1234'), deploy(2, '20:30', 'success', 'def5678', 'Preview')]);
    const items = sectionText.find((t) => t.startsWith('*Items*'))!;
    expect(items).toMatch(/MEDIUM · Deploy abc1234 to Production \(acme\/web\) failed\. .*The cause is not in the deployment record/);
    expect(shippedSection).toBe('*Shipped (context, not findings)*\n• 20:30 UTC · Deploy def5678 to Preview (acme/web) — deployment succeeded');
    expect(shippedSection).not.toMatch(/abc1234|failed/);
    expect(message.unknown.some((u) => /Deploy abc1234/.test(u))).toBe(true);
  });
});
