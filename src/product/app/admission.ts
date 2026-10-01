import type { Clock } from '../ports/clock.js';
import type { EntitlementLimits, EntitlementPolicy, EntitlementSubject } from '../ports/entitlements.js';
import type { Repositories, Transactor } from '../ports/persistence.js';
import type { Subscription, UsageKind } from '../ports/controlPlane.js';

export type ResourceKind = 'workspace' | 'watch' | 'source';
export type ExecutionKind = UsageKind;

export interface AdmissionDecision {
  allowed: boolean;
  code: 'allowed' | 'duplicate' | 'inactive_subscription' | 'capability_denied' | 'limit_reached' | 'invalid_scope';
  detail: string;
  usageRecorded?: boolean;
}

export class AdmissionDenied extends Error {
  constructor(readonly decision: AdmissionDecision) {
    super(decision.detail);
    this.name = 'AdmissionDenied';
  }
}

export interface AdmissionService {
  withResource<T>(kind: ResourceKind, subject: Required<Pick<EntitlementSubject, 'organizationId'>> & EntitlementSubject, create: (repos: Repositories) => Promise<T>): Promise<T>;
  execution(kind: ExecutionKind, subject: Required<Pick<EntitlementSubject, 'organizationId' | 'workspaceId'>> & EntitlementSubject, operationId: string): Promise<AdmissionDecision>;
}

const active = (subscription: Subscription) => subscription.status === 'active' || subscription.status === 'trialing';

export function usagePeriod(at: string, subscription?: Subscription): { start: string; end: string } {
  if (subscription?.periodStart && subscription.periodEnd && subscription.periodStart <= at && at < subscription.periodEnd) return { start: subscription.periodStart, end: subscription.periodEnd };
  const d = new Date(at);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  return { start, end };
}

const resourceLimit = (limits: EntitlementLimits, kind: ResourceKind) => kind === 'workspace' ? limits.maxWorkspaces : kind === 'watch' ? limits.maxWatches : limits.maxSources;
const usageLimit = (limits: EntitlementLimits, kind: ExecutionKind) => kind === 'investigation_execution' ? limits.investigationExecutionsPerPeriod : kind === 'source_check' ? limits.sourceChecksPerPeriod : limits.plannerExecutionsPerPeriod;
const denied = (code: AdmissionDecision['code'], detail: string): AdmissionDecision => ({ allowed: false, code, detail });

async function legacyAllows(policy: EntitlementPolicy, kind: ResourceKind | ExecutionKind, subject: EntitlementSubject) {
  if (kind === 'workspace') return policy.canCreateWorkspace(subject);
  if (kind === 'watch') return policy.canCreateWatch(subject);
  if (kind === 'source') return policy.canConnectSource(subject);
  if (kind === 'planner_execution') return policy.canUsePlanner(subject);
  return policy.canRunInvestigation(subject);
}

async function count(repos: Repositories, organizationId: string, kind: ResourceKind) {
  if (kind === 'workspace') return repos.workspaces.countForOrganization(organizationId);
  if (kind === 'watch') return repos.watches.countForOrganization(organizationId);
  return repos.sourceTargets.countForOrganization(organizationId);
}

/** One control-plane boundary for resource admission and retry-safe execution accounting. */
export function createAdmissionService(deps: { repos: Repositories; tx: Transactor; entitlements: EntitlementPolicy; clock: Clock }): AdmissionService {
  return {
    async withResource(kind, subject, create) {
      return deps.tx.run(async (repos) => {
        const at = deps.clock.now();
        const subscription = await repos.subscriptions.lock(subject.organizationId, at);
        if (!active(subscription)) throw new AdmissionDenied(denied('inactive_subscription', 'The organization subscription is not active.'));
        if (!(await legacyAllows(deps.entitlements, kind, subject))) throw new AdmissionDenied(denied('capability_denied', `The organization cannot create this ${kind}.`));
        const limit = resourceLimit(await deps.entitlements.limitsFor(subscription), kind);
        if (limit !== undefined && (await count(repos, subject.organizationId, kind)) >= limit) throw new AdmissionDenied(denied('limit_reached', `The organization has reached its ${kind} limit.`));
        return create(repos);
      });
    },

    async execution(kind, subject, operationId) {
      return deps.tx.run(async (repos) => {
        const workspace = await repos.workspaces.get(subject.workspaceId);
        if (!workspace || workspace.organizationId !== subject.organizationId) return denied('invalid_scope', 'The execution workspace does not belong to this organization.');
        const existing = await repos.usage.get(subject.organizationId, operationId);
        if (existing) return { allowed: true, code: 'duplicate', detail: 'This operation was already admitted.', usageRecorded: false };
        const at = deps.clock.now();
        const subscription = await repos.subscriptions.lock(subject.organizationId, at);
        if (!active(subscription)) return denied('inactive_subscription', 'The organization subscription is not active.');
        if (!(await legacyAllows(deps.entitlements, kind, subject))) return denied('capability_denied', 'This operation is not included for the organization.');
        const limits = await deps.entitlements.limitsFor(subscription);
        if (kind === 'planner_execution' && limits.plannerAllowed === false) return denied('capability_denied', 'Planner execution is not included for the organization.');
        const period = usagePeriod(at, subscription);
        const limit = usageLimit(limits, kind);
        if (limit !== undefined && (await repos.usage.sum(subject.organizationId, kind, period.start, period.end)) >= limit) return denied('limit_reached', `The organization has reached its ${kind.replace(/_/g, ' ')} limit.`);
        const added = await repos.usage.add({ id: operationId, organizationId: subject.organizationId, workspaceId: subject.workspaceId, kind, amount: 1, periodStart: period.start, periodEnd: period.end, occurredAt: at });
        return { allowed: true, code: added ? 'allowed' : 'duplicate', detail: added ? 'Operation admitted.' : 'This operation was already admitted.', usageRecorded: added };
      });
    },
  };
}

