import { migrateDecisions, migrateResult, migrateWatch } from '@/product/migrations/roles';
import type { ProductState } from './productContext';

/**
 * Stored product workspace → current shape. Returns undefined for anything unrecognisable (the
 * caller then starts fresh rather than loading a half-understood workspace).
 *
 *   v2 → v3: vendor-named signals, tools and actions become role-based (see product/migrations/roles).
 */
export function migrateStoredProductState(raw: unknown): ProductState | undefined {
  const s = raw as { version?: number } & Partial<Omit<ProductState, 'version'>>;
  if (!s || typeof s !== 'object' || !Array.isArray(s.watches)) return undefined;
  let state: ProductState;
  if (s.version === 3) state = s as ProductState;
  else if (s.version === 2) {
    state = {
      ...(s as Omit<ProductState, 'version'>),
      version: 3,
      watches: s.watches.map(migrateWatch),
      result: s.result ? migrateResult(s.result) : undefined,
      decisions: migrateDecisions(s.decisions ?? {}),
    };
  } else return undefined;
  // Workspaces saved before data modes existed were the sample workspace.
  if (!state.workspace && state.result) state.workspace = { mode: 'sample', createdAt: state.clock };
  return state;
}
