import type { ConnectionState, ProviderId, SourceConnection } from '../types.js';

/**
 * The Create Watch wizard's "Where should I look?" step, as data. A template names sources the
 * workspace may not have a connection record for:
 *   - a server workspace shows an empty connection list until its snapshot arrives (loading), and
 *   - a loaded server workspace lists only the sources it has actually connected.
 * Neither may crash the wizard, and neither may let a watch be created on sources not yet known.
 */

export type WizardSourceRow =
  | { provider: ProviderId; status: 'ready'; state: ConnectionState }
  /** The server workspace's connections have not arrived yet. */
  | { provider: ProviderId; status: 'loading' }
  /** Loaded, and this workspace has no connection for the source. */
  | { provider: ProviderId; status: 'missing' };

export interface WizardContext {
  location: 'browser' | 'server';
}

/**
 * A loaded server workspace always lists at least its built-in alert channel; an empty list is the
 * loading fallback shown before the snapshot arrives.
 */
export function connectionsPending(connections: SourceConnection[], ctx: WizardContext): boolean {
  return ctx.location === 'server' && connections.length === 0;
}

export function wizardSourceRows(providers: readonly ProviderId[], connections: SourceConnection[], ctx: WizardContext): WizardSourceRow[] {
  const pending = connectionsPending(connections, ctx);
  return providers.map((provider) => {
    const c = connections.find((x) => x.provider === provider);
    if (c) return { provider, status: 'ready', state: c.state };
    return pending ? { provider, status: 'loading' } : { provider, status: 'missing' };
  });
}

/**
 * Sources ticked when the step opens.
 *   imported: every source except those with nothing imported (unchanged behaviour)
 *   server:   only sources this workspace has connected — never one still loading or missing
 *   sample:   every template source (unchanged behaviour)
 */
export function initialWizardSources(providers: readonly ProviderId[], connections: SourceConnection[], ctx: WizardContext & { mode?: string }): ProviderId[] {
  if (ctx.mode === 'imported') return providers.filter((p) => connections.find((c) => c.provider === p)?.state !== 'not_configured');
  if (ctx.location === 'server') return wizardSourceRows(providers, connections, ctx).filter((r) => r.status === 'ready' && r.state !== 'not_configured').map((r) => r.provider);
  return [...providers];
}

/** Leaving the sources step needs at least one source, and a loaded record for every selected one. */
export function canLeaveSourceStep(selected: readonly ProviderId[], rows: WizardSourceRow[]): boolean {
  return selected.length > 0 && selected.every((p) => rows.find((r) => r.provider === p)?.status === 'ready');
}
