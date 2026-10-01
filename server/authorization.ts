import type { Membership, OrganizationMembership, Repositories, Workspace } from '../src/product/ports/persistence.js';
import type { Principal } from './auth.js';

export interface PrincipalContext {
  userId: string;
  organizationId: string;
  organizationRole: OrganizationMembership['role'];
  workspaceId: string;
  workspaceRole: Membership['role'];
  permissions: { manageWorkspace: boolean; manageConnections: boolean; approveConsequential: boolean };
  workspace: Workspace;
  membership: Membership;
}

/** The single user → organization → workspace authorization resolution boundary. */
export async function resolveWorkspaceContext(repos: Repositories, principal: Principal, workspaceId: string): Promise<PrincipalContext | null> {
  const membership = principal.memberships.find((m) => m.workspaceId === workspaceId);
  if (!membership) return null;
  const workspace = await repos.workspaces.get(workspaceId);
  if (!workspace?.organizationId) return null;
  const organizationMembership = principal.organizationMemberships.find((m) => m.organizationId === workspace.organizationId);
  if (!organizationMembership) return null;
  const manageWorkspace = membership.role === 'owner' || membership.role === 'admin';
  return {
    userId: principal.user.id,
    organizationId: workspace.organizationId,
    organizationRole: organizationMembership.role,
    workspaceId,
    workspaceRole: membership.role,
    permissions: { manageWorkspace, manageConnections: manageWorkspace, approveConsequential: membership.canApprove },
    workspace,
    membership,
  };
}
