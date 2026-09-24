import { beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings, seedTasks } from '@/domain/defaults';
import type { OvernightRun } from '@/domain/types';
import { runScenario } from './runScenario';

let run: OvernightRun;
beforeAll(async () => {
  run = await runScenario('checkout-regression', defaultSettings(), { seedTasks: seedTasks() });
});

const headline = () => run.investigations.find((i) => i.primarySignalId === 'sig-subscription_conversion')!;

describe('overnight run — checkout regression', () => {
  it('monitors every watched signal and detects the anomalies', () => {
    expect(run.stats.signalsMonitored).toBe(42);
    expect(run.stats.anomaliesDetected).toBe(5);
    expect(run.brief.counts).toMatchObject({ critical: 1, attention: 2, normal: 37 });
  });

  it('waits for persistence before investigating', () => {
    const watch = run.events.find((e) => e.stage === 'detect' && e.result.includes('Watching Subscription conversion'));
    const detect = run.events.find((e) => e.stage === 'detect' && e.result.startsWith('Detected') && e.result.includes('Subscription conversion'));
    expect(watch).toBeDefined();
    expect(Date.parse(detect!.at)).toBeGreaterThan(Date.parse(watch!.at));
  });

  it('collects evidence from analytics, payments, GitHub and support', () => {
    const inv = headline();
    const kinds = inv.evidence.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['driver_moved', 'traffic_stable', 'provider_outlier', 'provider_normal', 'deployment', 'merged_pr', 'support_cluster']));
    expect(inv.sourcesQueried).toEqual(expect.arrayContaining(['analytics', 'payments', 'github', 'support', 'experiments']));
    const klarna = inv.evidence.find((e) => e.kind === 'provider_outlier')!;
    expect(klarna.entities).toContain('klarna');
    expect(klarna.value).toBe('+31 pts');
    expect(inv.evidence.find((e) => e.kind === 'support_cluster')?.value).toBe('7');
    expect(inv.evidence.find((e) => e.id.endsWith('provider:paypal'))?.kind).toBe('provider_normal');
  });

  it('derives the Klarna/v4.8.1 hypothesis from the evidence with 87% confidence', () => {
    const inv = headline();
    const leading = inv.hypotheses.find((h) => h.id === inv.leadingHypothesisId)!;
    expect(leading.statement).toBe('Klarna checkout regression associated with release v4.8.1');
    expect(Math.round(inv.confidence! * 100)).toBe(87);
    expect(inv.confidenceBand).toBe('high');
    // Alternatives were considered and scored lower.
    expect(inv.hypotheses.map((h) => h.type)).toEqual(expect.arrayContaining(['provider_outage', 'release_regression', 'demand_shift', 'instrumentation']));
    expect(inv.hypotheses.filter((h) => h.id !== leading.id).every((h) => h.confidence < 0.1)).toBe(true);
    // Every weight is traceable to a piece of evidence.
    for (const w of leading.weights) expect(inv.evidence.some((e) => e.id === w.evidenceId)).toBe(true);
  });

  it('creates PAY-284 with the evidence, owned by Payments Engineering', () => {
    const task = run.tasks.find((t) => t.id === 'PAY-284')!;
    expect(task.title).toBe('Investigate Klarna checkout regression');
    expect(task.priority).toBe('P1');
    expect(task.ownerTeamId).toBe('payments-eng');
    expect(task.createdBy).toBe('nightwatch');
    expect(task.description.problem).toContain('Subscription conversion declined 11.8%');
    expect(task.description.impact).toBe('Checkout completion declined 14.0%.');
    expect(task.description.evidence).toEqual(expect.arrayContaining(['Klarna errors +31 pts', '7 related support complaints', 'Release v4.8.1 deployed at 18:42']));
    expect(task.description.sources).toEqual(['analytics', 'payments', 'github', 'support']);
    expect(task.comments.at(-1)?.body).toContain('support complaints 2 → 7');
  });

  it('drafts an incident and notifies on-call, but does not change production', () => {
    const executed = run.actions.filter((a) => a.status === 'executed').map((a) => a.type);
    expect(executed).toEqual(expect.arrayContaining(['create_task', 'create_incident_draft', 'notify_oncall']));
    expect(executed).not.toContain('rollback_release');
    expect(executed).not.toContain('disable_payment_method');
    expect(executed).not.toContain('customer_communication');
  });

  it('requests human approval for rollback, Klarna disablement and customer communication', () => {
    const types = run.approvals.filter((a) => a.investigationId === headline().id).map((a) => a.actionType);
    expect(types).toEqual(['disable_payment_method', 'rollback_release', 'customer_communication']);
    expect(run.approvals.every((a) => a.status === 'pending')).toBe(true);
    expect(run.brief.didNot.map((d) => d.label)).toEqual(['Klarna disablement', 'Production rollback', 'Customer communication']);
  });

  it('attributes the iOS activation drop to the onboarding experiment and drafts (not files) the task', () => {
    const inv = run.investigations.find((i) => i.primarySignalId === 'sig-activation_ios')!;
    expect(inv.severity).toBe('high');
    expect(inv.hypotheses[0].type).toBe('experiment_effect');
    expect(run.drafts.some((d) => d.investigationId === inv.id)).toBe(true);
    expect(run.approvals.some((a) => a.actionType === 'pause_experiment')).toBe(true);
  });

  it('says "Insufficient evidence" for the unexplained export decline', () => {
    const inv = run.investigations.find((i) => i.primarySignalId === 'sig-feature_export')!;
    expect(inv.status).toBe('insufficient_evidence');
    expect(inv.conclusion).toBe('Insufficient evidence.');
    expect(inv.leadingHypothesisId).toBeUndefined();
    // Nothing is presented as supporting a cause, and work is drafted — never auto-filed.
    expect(inv.evidence.every((e) => e.stance !== 'supports')).toBe(true);
    expect(run.tasks.some((t) => t.investigationId === inv.id)).toBe(false);
    expect(run.drafts.find((d) => d.investigationId === inv.id)?.description.hypothesis).toBe('Insufficient evidence — no cause identified.');
  });

  it('dismisses the transient active-user dip without creating work', () => {
    const inv = run.investigations.find((i) => i.status === 'dismissed')!;
    expect(inv.primarySignalId).toBe('sig-dau');
    expect(inv.taskIds).toHaveLength(0);
  });

  it('produces an auditable trace with timestamps, tools and decisions', () => {
    expect(run.events.length).toBeGreaterThan(50);
    expect(run.events.every((e, i) => i === 0 || Date.parse(e.at) >= Date.parse(run.events[i - 1].at))).toBe(true);
    expect(run.events.some((e) => e.approvalStatus === 'pending')).toBe(true);
    expect(run.events.at(-1)?.action).toBe('Morning brief generated');
  });

  it('is deterministic', async () => {
    const again = await runScenario('checkout-regression', defaultSettings(), { seedTasks: seedTasks() });
    expect(again.brief).toEqual(run.brief);
  });
});

describe('overnight run — configuration changes behaviour', () => {
  it('does not investigate conversion when conversion and payments are unwatched', async () => {
    const s = defaultSettings();
    s.watch.conversion = false;
    s.watch.payment_failures = false;
    const r = await runScenario('checkout-regression', s);
    expect(r.investigations.some((i) => i.primarySignalId === 'sig-subscription_conversion')).toBe(false);
  });

  it('routes the task to a different team when ownership changes', async () => {
    const s = defaultSettings();
    s.owners = s.owners.map((o) => (o.area === 'payments' ? { ...o, teamId: 'platform' } : o));
    const r = await runScenario('checkout-regression', s);
    expect(r.tasks.find((t) => t.kind === 'task')?.id).toMatch(/^PLAT-/);
  });

  it('only drafts the task when auto-filing is off', async () => {
    const s = defaultSettings();
    s.autonomy.autoFileMinSeverity = 'never';
    const r = await runScenario('checkout-regression', s);
    expect(r.tasks.filter((t) => t.kind === 'task')).toHaveLength(0);
    expect(r.drafts.some((d) => d.title === 'Investigate Klarna checkout regression')).toBe(true);
  });

  it('handles an unavailable issue tracker as a failed action and keeps a draft', async () => {
    const s = defaultSettings();
    s.integrations.issue_tracker = 'unavailable';
    const r = await runScenario('checkout-regression', s);
    expect(r.actions.some((a) => a.type === 'create_task' && a.status === 'failed')).toBe(true);
    expect(r.drafts.length).toBeGreaterThan(0);
  });

  it('does not open a duplicate issue when the same finding is already open', async () => {
    const first = await runScenario('checkout-regression', defaultSettings(), { seedTasks: seedTasks() });
    const second = await runScenario('checkout-regression', defaultSettings(), { seedTasks: first.tasks.concat(seedTasks()).filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i) });
    expect(second.tasks.filter((t) => t.title === 'Investigate Klarna checkout regression')).toHaveLength(1);
    expect(second.actions.find((a) => a.type === 'create_task')?.result).toContain('Already open as PAY-284');
  });
});
