import type { SourceTarget } from './ports/persistence.js';
import type { Watch } from './types.js';

/** Stable compatibility id for the aggregate target represented by a legacy connection. */
export const legacySourceTargetId = (connectionId: string) => `target-${connectionId}`;

/** Explicit target ids are authoritative; legacy watches resolve through their provider list. */
export function sourceTargetIdsForWatch(watch: Watch, targets: readonly SourceTarget[]): string[] {
  if (watch.sourceTargetIds?.length) return [...new Set(watch.sourceTargetIds)];
  const providers = new Set(watch.sources);
  return targets.filter((target) => providers.has(target.provider as never)).map((target) => target.id);
}
