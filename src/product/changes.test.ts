import { describe, expect, it } from 'vitest';
import type { MonitoringResult, SourceConnection, WatchInvestigation } from './types';
import { defaultBriefSchedule, watchFromTemplate } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { buildWorld, t } from './integrations/world';
import type { ReleaseRecord } from './integrations/types';
import { runMonitoring } from './engine/monitor';
import { hasCausalOverclaim } from './engine/language';
import { generatedTexts } from './evaluation/golden';

/**
 * Stage 2 — change evidence and source freshness.
 *
 * ACTUAL timing (a deploy finished, a build went live) can support a temporal association.
 * PLANNED timing (a tracker's release date) never does. A stale, unavailable or missing source is a
 * gap — never evidence that nothing happened.
 */

// Conversion and revenue both drop (a real drop, not a tracking conflict).
const drop = { 'ga4.checkout_conversion': [{ from: '19:00', change: -18 }], 'ga4.purchase_revenue': [{ from: '19:00', change: -16 }] };
const github = (patch: Partial<SourceConnection> = {}): SourceConnection => ({ provider: 'github', state: 'simulated', detail: 'Simulated deployments', updatedAt: '2026-09-23T17:55:00.000Z', ...patch });
const watch = () => watchFromTemplate('w-checkout', 'checkout_health', { sources: ['ga4', 'jira', 'app_store', 'google_play', 'github'] });

async function run(changes: ReleaseRecord[], gh: SourceConnection | null = github()): Promise<{ r: MonitoringResult; inv: WatchInvestigation }> {
  const world = buildWorld({ id: 'chg', name: 'changes', seed: 481, effects: drop, releases: changes });
  const connections = gh ? [...defaultConnections(), gh] : defaultConnections();
  const r = await runMonitoring({ world, watches: [watch()], connections, brief: defaultBriefSchedule() });
  return { r, inv: r.investigations.find((i) => i.area === 'checkout')! };
}

const deploy = (at: string, patch: Partial<ReleaseRecord> = {}): ReleaseRecord => ({ id: `gh-dep-${at}`, provider: 'github', kind: 'deploy', timing: 'actual', title: 'checkout-api@9f1c', version: '', platform: 'web', releasedAt: t(at), notes: 'Production deployment', status: 'success', ...patch });
const hyp = (inv: WatchInvestigation, k: string) => inv.agentHypotheses.find((h) => h.kind === k)!;
const noOverclaim = (r: MonitoringResult) => expect(generatedTexts(r).filter(hasCausalOverclaim)).toEqual([]);

describe('change evidence: actual, planned, reported', () => {
  it('an ACTUAL deploy before the drop is a temporal association — never a cause', async () => {
    const { r, inv } = await run([deploy('18:35')]);
    expect(inv.releaseAssociation).toMatchObject({ version: 'checkout-api@9f1c', kind: 'deploy', timing: 'actual', minutesBeforeOnset: 25 });
    expect(inv.evidence.find((e) => e.changeKind === 'deploy')?.statement).toMatch(/deploy checkout-api@9f1c at 18:35/);
    expect(inv.likelyExplanation).toMatch(/shortly after deploy checkout-api@9f1c.*does not establish causation/);
    expect(inv.unknowns.join(' ')).toMatch(/Whether deploy checkout-api@9f1c is responsible/);
    expect(hyp(inv, 'release_related').strength).toBe('weak');
    noOverclaim(r);
  });

  it('a PLANNED release date alone is never a timing association', async () => {
    const planned: ReleaseRecord = { id: 'jira-rel-4.8.1', provider: 'jira', timing: 'planned', version: '4.8.1', platform: 'all', releasedAt: t('18:30'), notes: 'Marked released in the tracker' };
    const { r, inv } = await run([planned]);
    expect(inv.releaseAssociation).toBeUndefined();
    expect(inv.evidence.find((e) => e.timing === 'planned')?.statement).toMatch(/dated 18:30 — a planned date, not when it reached users/);
    expect(inv.unknowns.join(' ')).toMatch(/only its planned date/);
    expect(hyp(inv, 'release_related').strength).not.toMatch(/moderate|strong/);
    // A planned date does not lift attention the way a release that reached users does.
    expect(inv.attention).toBe('MEDIUM');
    expect(`${inv.likelyExplanation} ${inv.inferred.join(' ')} ${inv.summary}`).not.toMatch(/after release 4\.8\.1/);
    noOverclaim(r);
  });

  it('a REPORTED change (an annotation) can be associated, and says its time is reported', async () => {
    const { r, inv } = await run([deploy('18:40', { kind: 'annotation', timing: 'reported', title: 'Promo banner launched' })]);
    expect(inv.releaseAssociation).toMatchObject({ kind: 'annotation', timing: 'reported', minutesBeforeOnset: 20 });
    expect(inv.inferred.join(' ')).toMatch(/annotated change “Promo banner launched” \(a reported time\) — a temporal association/);
    noOverclaim(r);
  });

  it('conflicting timing: the observed time wins over the planned date', async () => {
    // The tracker says 18:30; the build only reached users at 19:20 — after the drop began at 19:00.
    const { r, inv } = await run([
      { id: 'jira-rel-4.8.1', provider: 'jira', timing: 'planned', version: '4.8.1', platform: 'all', releasedAt: t('18:30'), notes: 'Marked released' },
      { id: 'as-rel-4.8.1', provider: 'app_store', timing: 'actual', version: '4.8.1', platform: 'ios', releasedAt: t('19:20'), notes: 'Phased release started', rollout: 'Phased release' },
    ]);
    expect(inv.releaseAssociation).toBeUndefined();
    expect(inv.evidence.filter((e) => e.changeKind === 'release').map((e) => e.timing).sort()).toEqual(['actual', 'planned']);
    expect(inv.unknowns.join(' ')).not.toMatch(/only its planned date/);
    noOverclaim(r);
  });

  it('an incident is evidence, not a change that precedes anything', async () => {
    const { r, inv } = await run([deploy('18:50', { kind: 'incident', title: 'Payments API degraded' })]);
    expect(inv.releaseAssociation).toBeUndefined();
    expect(inv.evidence.some((e) => e.changeKind === 'incident' && /incident “Payments API degraded” recorded at 18:50/.test(e.statement))).toBe(true);
    expect(hyp(inv, 'external_or_unobserved').statement).toMatch(/Payments API degraded/);
    expect(inv.unknowns.join(' ')).toMatch(/Whether the incident “Payments API degraded”.*not established/);
    noOverclaim(r);
  });
});

describe('source freshness and coverage: silence is not evidence', () => {
  const noChangeEvidence = (inv: WatchInvestigation, source: string) => inv.evidence.filter((e) => e.provider === source && e.direction === 'stable');

  it('a STALE source: what it returns is used, but its silence after the last sync proves nothing', async () => {
    const fresh = await run([deploy('18:35')]);
    expect(fresh.inv.releaseAssociation?.kind).toBe('deploy');
    // Same night, but GitHub last synced at 18:10 — the 18:35 deploy was never seen.
    const { r, inv } = await run([deploy('18:35')], github({ freshAsOf: t('18:10') }));
    expect(inv.releaseAssociation).toBeUndefined();
    expect(noChangeEvidence(inv, 'github')).toEqual([]);
    expect(inv.evidence.find((e) => e.provider === 'github' && e.gap === 'stale')?.statement).toMatch(/only complete up to 18:10/);
    expect(inv.unknowns.join(' ')).toMatch(/GitHub data is only complete up to 18:10/);
    expect(inv.uncertainty).toMatch(/GitHub data is incomplete after 18:10/);
    expect(hyp(inv, 'release_related').status).not.toBe('ruled_out');
    expect(inv.confidence).toBeLessThan(fresh.inv.confidence);
    noOverclaim(r);
  });

  it('an UNAVAILABLE source is a gap, not "no changes"', async () => {
    const { inv } = await run([deploy('18:35')], github({ state: 'unavailable', detail: 'GitHub API timed out' }));
    expect(inv.releaseAssociation).toBeUndefined();
    expect(noChangeEvidence(inv, 'github')).toEqual([]);
    expect(inv.evidence.find((e) => e.provider === 'github' && e.direction === 'gap')?.gap).toBe('unavailable');
    expect(inv.trace.some((s) => s.kind === 'tool_call' && s.source === 'github')).toBe(false);
    expect(hyp(inv, 'release_related').status).not.toBe('ruled_out');
  });

  it('a MISSING source (in the watch, not configured) is a gap — never checked, never negative', async () => {
    const { inv } = await run([deploy('18:35')], github({ state: 'not_configured', detail: 'Not connected' }));
    const gap = inv.evidence.find((e) => e.provider === 'github' && e.direction === 'gap');
    expect(gap?.gap).toBe('not_configured');
    expect(gap?.statement).toMatch(/GitHub is not configured — its data was not checked/);
    expect(noChangeEvidence(inv, 'github')).toEqual([]);
    expect(inv.trace.some((s) => s.kind === 'tool_call' && s.source === 'github')).toBe(false);
  });

  it('a watch that names a source the workspace does not have: a gap, never "no changes"', async () => {
    const { inv } = await run([deploy('18:35')], null);
    expect(inv.evidence.filter((e) => e.provider === 'github').map((e) => e.gap)).toEqual(['not_configured']);
    expect(inv.releaseAssociation).toBeUndefined();
  });
});

describe('causality restraint holds for every kind of change', () => {
  it('no change kind or timing ever makes the change explanation strong, or produces causal wording', async () => {
    for (const kind of ['deploy', 'release', 'flag_change', 'experiment_change', 'config_change', 'annotation'] as const) {
      for (const timing of ['actual', 'planned', 'reported'] as const) {
        const { r, inv } = await run([deploy('18:35', { kind, timing, version: kind === 'release' ? '4.9.0' : '' })]);
        expect(hyp(inv, 'release_related').strength).not.toBe('strong');
        if (timing === 'planned') expect(inv.releaseAssociation).toBeUndefined();
        else expect(inv.releaseAssociation?.timing).toBe(timing);
        noOverclaim(r);
      }
    }
  }, 60_000);
});
