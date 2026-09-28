export interface EntitlementSubject {
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
}

export interface EntitlementPolicy {
  canCreateWorkspace(subject: EntitlementSubject): Promise<boolean>;
  canCreateWatch(subject: EntitlementSubject): Promise<boolean>;
  canConnectSource(subject: EntitlementSubject): Promise<boolean>;
  canRunInvestigation(subject: EntitlementSubject): Promise<boolean>;
  canUsePlanner(subject: EntitlementSubject): Promise<boolean>;
}

/** Validation policy: preserves today's permissive product behavior behind one future policy seam. */
export const permissiveEntitlements: EntitlementPolicy = {
  canCreateWorkspace: async () => true,
  canCreateWatch: async () => true,
  canConnectSource: async () => true,
  canRunInvestigation: async () => true,
  canUsePlanner: async () => true,
};
