import type { Subscription } from './controlPlane.js';

export interface EntitlementSubject {
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
}

export interface EntitlementLimits {
  maxWorkspaces?: number;
  maxWatches?: number;
  maxSources?: number;
  investigationExecutionsPerPeriod?: number;
  sourceChecksPerPeriod?: number;
  plannerExecutionsPerPeriod?: number;
  plannerAllowed?: boolean;
}

export interface EntitlementPolicy {
  /** Plan calculation only. Resource counting and usage reservation belong to admission. */
  limitsFor(subscription: Subscription): Promise<EntitlementLimits>;
  canCreateWorkspace(subject: EntitlementSubject): Promise<boolean>;
  canCreateWatch(subject: EntitlementSubject): Promise<boolean>;
  canConnectSource(subject: EntitlementSubject): Promise<boolean>;
  canRunInvestigation(subject: EntitlementSubject): Promise<boolean>;
  canUsePlanner(subject: EntitlementSubject): Promise<boolean>;
}

/** Validation policy: preserves today's permissive product behavior behind one future policy seam. */
export const permissiveEntitlements: EntitlementPolicy = {
  limitsFor: async () => ({}),
  canCreateWorkspace: async () => true,
  canCreateWatch: async () => true,
  canConnectSource: async () => true,
  canRunInvestigation: async () => true,
  canUsePlanner: async () => true,
};

/** Small configurable policy for tests and future billing adapters; unknown plans use `fallback`. */
export function planEntitlements(plans: Record<string, EntitlementLimits>, fallback: EntitlementLimits = {}): EntitlementPolicy {
  return {
    ...permissiveEntitlements,
    limitsFor: async (subscription) => plans[subscription.planId] ?? fallback,
  };
}
