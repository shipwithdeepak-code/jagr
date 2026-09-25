import type { SourceConnection } from '../types.js';
import type { MetricDefinition, MetricKey, RegisteredSource, Role, SourceId } from './types.js';

/**
 * SourceRegistry — resolves "which sources can answer this role?" for a workspace.
 *
 * Order is significant and stable: it is the order the workspace registered its sources, and the
 * engine consults sources in that order. The registry is the only place that knows which concrete
 * source implements a role; the investigator only ever sees source ids and roles.
 */
export class SourceRegistry {
  private readonly byId: Map<SourceId, RegisteredSource>;

  constructor(private readonly list: RegisteredSource[]) {
    this.byId = new Map(list.map((s) => [s.id, s]));
  }

  sources(): RegisteredSource[] {
    return [...this.list];
  }

  get(id: SourceId): RegisteredSource | undefined {
    return this.byId.get(id);
  }

  connection(id: SourceId): SourceConnection | undefined {
    return this.byId.get(id)?.connection;
  }

  roles(id: SourceId): Role[] {
    const s = this.byId.get(id);
    if (!s) return [];
    return (['metrics', 'changes', 'work_items', 'feedback', 'conversations', 'context'] as const).filter((r) => !!s[r]);
  }

  /** Sources that implement a role, optionally limited to a watch's sources — in registry order. */
  withRole(role: Role, among?: readonly SourceId[]): RegisteredSource[] {
    return this.list.filter((s) => !!s[role] && (!among || among.includes(s.id)));
  }

  /** Every metric the workspace can read, with the source that serves it. */
  metrics(among?: readonly SourceId[]): { source: SourceId; def: MetricDefinition }[] {
    return this.withRole('metrics', among).flatMap((s) => s.metrics!.metricDefinitions().map((def) => ({ source: s.id, def })));
  }

  /** The source that serves a metric (first in registry order), optionally within a watch. */
  metricSource(key: MetricKey, among?: readonly SourceId[]): { source: SourceId; def: MetricDefinition } | undefined {
    return this.metrics(among).find((m) => m.def.key === key);
  }

  /** Links to a record are simulated unless the source is a real, connected connector. */
  isSimulated(id: SourceId): boolean {
    return this.byId.get(id)?.connection.state !== 'connected';
  }
}
