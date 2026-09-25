import type { ActionDecision, EmailNotification, MorningBriefDoc, Watch, WatchInvestigation } from '../types';
import { briefView } from '../view/brief';
import type { Clock } from '../ports/clock';
import type { HttpClient } from '../ports/http';
import type { DeliveryTarget, NotificationChannel, NotificationMessage } from '../ports/notify';
import type { Connection, Repositories, Workspace } from '../ports/persistence';
import type { SecretPayload, SecretStore } from '../ports/secrets';
import { redactPersonalData } from '../lib/redact';
import type { ConnectorCheck } from '../integrations/connectors/types';

/**
 * Outbound notification delivery — vendor-neutral. The engine decides WHAT to tell people (alerts by
 * each watch's notification policy, and morning briefs); this service turns those decisions into
 * domain-level NotificationMessages and hands them to every outbound channel the workspace has
 * connected. Channels render and send; they never decide, and they never approve anything: an
 * approval request links back to Jagr, where a signed-in member decides.
 *
 * Delivery is idempotent per (channel connection, dedupe key) and recorded in the delivery log. A
 * channel failure is recorded and never fails the monitoring run.
 */

/** Builds an outbound channel from a connection (registered per provider at the composition root). */
export type ChannelFactory = (conn: Connection, ctx: { secret?: SecretPayload; http: HttpClient; clock: Clock }) => {
  channel: NotificationChannel;
  target: DeliveryTarget;
  /** Verify the credential without sending anything. */
  check(): Promise<ConnectorCheck>;
};

export interface DeliveryDeps {
  repos: Repositories;
  secrets: SecretStore;
  http: HttpClient;
  clock: Clock;
  channels?: Record<string, ChannelFactory>;
  appBaseUrl?: string;
}

const clean = (s: string) => redactPersonalData(s);
const absolute = (base: string | undefined, path: string, fallback: string) => (base && /^https:\/\//.test(base) ? `${base.replace(/\/$/, '')}${path}` : fallback);

/** An alert the engine decided to send, as a domain message. */
export function alertMessage(workspaceId: string, email: EmailNotification, inv: WatchInvestigation | undefined, appBaseUrl?: string): NotificationMessage {
  const link = inv ? absolute(appBaseUrl, inv.jagrPath, inv.jagrLink) : undefined;
  const pending = inv?.actions.find((a) => a.status === 'awaiting_approval');
  return {
    kind: pending ? 'approval_requested' : 'investigation_confirmed',
    workspaceId,
    dedupeKey: `alert:${email.id}`,
    title: clean(inv?.title ?? email.subject),
    attention: email.attention ?? inv?.attention,
    summary: clean(email.sections.whatChanged),
    observed: (inv?.observed ?? email.sections.whatJagrFound).slice(0, 6).map(clean),
    inferred: (inv?.inferred ?? [email.sections.likelyExplanation]).slice(0, 4).map(clean),
    unknown: (inv?.unknowns ?? [email.sections.uncertainty]).slice(0, 4).map(clean),
    links: link ? [{ label: 'Open investigation in Jagr', href: link }] : [],
    approval: pending ? { actionId: pending.id, risk: pending.risk, what: clean(pending.title) } : undefined,
  };
}

/**
 * A morning brief, as a domain message — built from the same brief view the Briefs page shows (same
 * items, same attention, same quiet count), so the channel never ranks or words things differently.
 */
export function briefMessage(workspaceId: string, brief: MorningBriefDoc, ctx: { investigations: WatchInvestigation[]; watches: Watch[]; decisions?: Record<string, ActionDecision>; appBaseUrl?: string }): NotificationMessage {
  const v = briefView(brief, { investigations: ctx.investigations, watches: ctx.watches, decisions: ctx.decisions ?? {} });
  const byId = new Map(ctx.investigations.map((i) => [i.id, i]));
  const quiet = v.quiet.signals ? `Quiet: ${v.quiet.signals} monitored signal${v.quiet.signals === 1 ? '' : 's'} showed no meaningful change.` : v.quiet.note;
  return {
    kind: 'morning_brief',
    workspaceId,
    dedupeKey: `brief:${brief.generatedAt}`,
    title: clean(`Good morning. ${v.headline}`),
    summary: quiet,
    observed: v.items.slice(0, 6).map((i) => clean(`${i.attention} · ${i.headline}. What changed: ${i.whatChanged}${i.found.length ? ` What Jagr found: ${i.found.join(' ')}` : ''} Recommended: ${i.next}${i.approvalsWaiting ? ` (${i.approvalsWaiting} awaiting approval)` : ''}`)),
    inferred: [],
    unknown: v.items.slice(0, 6).map((i) => clean(`${i.headline}: ${i.uncertainty}`)),
    links: [
      ...v.items.slice(0, 4).flatMap((i) => {
        const inv = byId.get(i.investigationId);
        return inv ? [{ label: `Open: ${i.headline}`.slice(0, 70), href: absolute(ctx.appBaseUrl, inv.jagrPath, inv.jagrLink) }] : [];
      }),
      { label: 'Open the brief', href: absolute(ctx.appBaseUrl, '/briefs', 'https://jagr.vercel.app/briefs') },
    ],
  };
}

export interface DeliverySummary {
  delivered: number;
  duplicates: number;
  failed: number;
}

/** Send messages to every outbound channel connected to the workspace. Never throws for a channel failure. */
export async function deliver(deps: DeliveryDeps, ws: Workspace, messages: NotificationMessage[]): Promise<DeliverySummary> {
  const out: DeliverySummary = { delivered: 0, duplicates: 0, failed: 0 };
  if (!messages.length || !deps.channels) return out;
  const conns = (await deps.repos.connections.list(ws.id)).filter((c) => !c.roles.length && c.state === 'connected' && Object.prototype.hasOwnProperty.call(deps.channels, c.provider));
  if (!conns.length) return out;
  const log = new Map((await deps.repos.notifications.list(ws.id)).filter((n) => n.status === 'delivered').map((n) => [n.id, n]));
  for (const c of conns) {
    let built: ReturnType<ChannelFactory> | undefined;
    let setupError: string | undefined;
    try {
      const secret = c.secretRef ? (await deps.secrets.get(c.secretRef)).secret : undefined;
      built = deps.channels[c.provider](c, { secret, http: deps.http, clock: deps.clock });
    } catch (e) {
      setupError = (e as Error).message.slice(0, 200);
    }
    for (const m of messages) {
      const id = `${c.id}:${m.dedupeKey}`;
      if (log.has(id)) {
        out.duplicates++;
        continue;
      }
      const at = deps.clock.now();
      let status: 'delivered' | 'failed' = 'failed';
      let detail = setupError ?? '';
      if (built) {
        try {
          const r = await built.channel.send(m, built.target);
          status = r.status === 'failed' ? 'failed' : 'delivered';
          detail = r.detail ?? (r.externalId ? `message ${r.externalId}` : '');
        } catch (e) {
          detail = `${built.channel.kind} delivery failed: ${(e as Error).message.slice(0, 200)}`;
        }
      }
      // The store deduplicates on (channel, dedupe key): a delivered message holds its key, so it is never
      // logged — or sent by a later run — twice. A failed attempt is logged under its own key, so the same
      // message is tried again the next time it is delivered.
      const key = `${c.id}:${m.dedupeKey}`;
      const record = { id: status === 'delivered' ? id : `${id}#failed@${at}`, channel: c.provider, dedupeKey: status === 'delivered' ? key : `${key}#failed@${at}`, deliveredAt: at, status, detail: clean(`${m.kind} · ${m.title}${detail ? ` · ${detail}` : ''}`).slice(0, 400) };
      await deps.repos.notifications.add(ws.id, record);
      if (status === 'delivered') log.set(id, record);
      if (status === 'delivered') out.delivered++;
      else out.failed++;
    }
  }
  return out;
}
