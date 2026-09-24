import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/domain/defaults';
import type { ActionType, WorkspaceSettings } from '@/domain/types';
import { ACTION_CATALOG, assertExecutable, assessRisk, evaluatePolicy, GuardrailViolation } from './policy';

const settings = defaultSettings();
const withAutonomy = (patch: Partial<WorkspaceSettings['autonomy']>): WorkspaceSettings => ({ ...settings, autonomy: { ...settings.autonomy, ...patch } });

describe('risk classification', () => {
  it('rates production, payments and customer-facing actions as gated', () => {
    expect(assessRisk('rollback_release', {}).risk).toBe('high');
    expect(assessRisk('disable_payment_method', { providerShare: 0.31 }).reasons).toContain('Affects ~31% of checkout attempts');
    expect(assessRisk('customer_communication', {}).risk).toBe('medium');
    expect(assessRisk('create_task', {}).risk).toBe('low');
  });

  it('puts every level-4 action behind a gate', () => {
    for (const [type, spec] of Object.entries(ACTION_CATALOG)) {
      if (spec.level === 4) expect(spec.gatedBy, type).toBeDefined();
    }
  });
});

describe('autonomy policy', () => {
  it('executes low-risk work and requires approval for consequential actions', () => {
    expect(evaluatePolicy('create_task', 'critical', settings).decision).toBe('execute');
    expect(evaluatePolicy('create_incident_draft', 'critical', settings).decision).toBe('execute');
    expect(evaluatePolicy('notify_oncall', 'critical', settings).decision).toBe('execute');
    const gated: ActionType[] = ['rollback_release', 'disable_payment_method', 'pricing_change', 'refund', 'customer_communication', 'production_config_change', 'pause_experiment'];
    for (const t of gated) expect(evaluatePolicy(t, 'critical', settings).decision, t).toBe('require_approval');
  });

  it('drafts tasks below the auto-file severity instead of filing them', () => {
    expect(evaluatePolicy('create_task', 'high', settings).decision).toBe('draft');
    expect(evaluatePolicy('create_task', 'critical', withAutonomy({ autoFileMinSeverity: 'never' })).decision).toBe('draft');
    expect(evaluatePolicy('create_task', 'critical', withAutonomy({ createTasks: false })).decision).toBe('draft');
  });

  it('never lets a gate be configured into autonomous execution', () => {
    const off = withAutonomy({ gates: { ...settings.autonomy.gates, payments: 'disabled' } });
    expect(evaluatePolicy('disable_payment_method', 'critical', off).decision).toBe('recommend_only');
  });

  it('respects escalation routing for on-call notifications', () => {
    expect(evaluatePolicy('notify_oncall', 'high', settings).decision).toBe('recommend_only');
    expect(evaluatePolicy('notify_oncall', 'critical', { ...settings, criticalEscalation: false }).decision).toBe('recommend_only');
  });

  it('turning off a lower autonomy level disables everything above it', () => {
    const noRecommend = withAutonomy({ recommend: false });
    expect(evaluatePolicy('create_task', 'critical', noRecommend).decision).toBe('not_permitted');
    expect(evaluatePolicy('rollback_release', 'critical', noRecommend).decision).toBe('not_permitted');
  });
});

describe('execution guardrail', () => {
  it('refuses level-4 actions without an approved approval', () => {
    expect(() => assertExecutable('rollback_release')).toThrow(GuardrailViolation);
    expect(() => assertExecutable('rollback_release', { status: 'pending' })).toThrow(GuardrailViolation);
    expect(() => assertExecutable('rollback_release', { status: 'approved' })).not.toThrow();
    expect(() => assertExecutable('create_task')).not.toThrow();
  });
});
