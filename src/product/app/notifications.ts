import type { ActionDecision, EmailNotification, MorningBriefDoc, Watch, WatchInvestigation } from '../types.js';
import { briefView } from '../view/brief.js';
import type { Clock } from '../ports/clock.js';
import type { HttpClient } from '../ports/http.js';
import type { DeliveryTarget, NotificationChannel, NotificationMessage } from '../ports/notify.js';
import type { Connection, NotificationRecord, Repositories, Workspace } from '../ports/persistence.js';
import { uniqueId } from './ids.js';
import type { SecretPayload, SecretStore } from '../ports/secrets.js';
import { redactPersonalData } from '../lib/redact.js';
import { fmtTime } from '../lib/time.js';
import { PROVIDERS } from '../integrations/adapters.js';
import type { ConnectorCheck } from '../integrations/connectors/types.js';

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
  // Changes shipped, as in the app's brief: what the change sources reported, not findings and not causes.
  const shippedLines = v.shipped.slice(0, SHIPPED_MAX).map((c) => clean(`${fmtTime(c.at)} UTC · ${c.title} — ${c.kind === 'release' ? 'release published' : 'deployment succeeded'}`));
  if (v.shipped.length > SHIPPED_MAX) shippedLines.push(`and ${v.shipped.length - SHIPPED_MAX} more in Jagr`);
  const shippedUnavailable = v.shippedUnavailable.map((p) => PROVIDERS[p as keyof typeof PROVIDERS]?.name ?? p);
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
    ...(shippedLines.length || shippedUnavailable.length ? { shipped: { lines: shippedLines, unavailable: shippedUnavailable } } : {}),
  };
}

/** Shipped changes listed in a brief message; the rest are counted. */
const SHIPPED_MAX = 10;

/** A claim still 'sending' after this long was interrupted (a send takes seconds). */
export const STUCK_CLAIM_MS = 15 * 60_000;

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
  const byKey = new Map((await deps.repos.notifications.list(ws.id)).map((n) => [`${n.channel} ${n.dedupeKey}`, n]));
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
      const key = `${c.id}:${m.dedupeKey}`;
      const at = deps.clock.now();
      const line = (detail: string) => clean(`${m.kind} · ${m.title}${detail ? ` · ${detail}` : ''}`).slice(0, 400);
      // Claim before sending. The store's (channel, dedupe key) uniqueness makes the claim atomic, so two
      // workers — or a retried job — never both send the same message. Delivered keeps the key forever.
      const existing = byKey.get(`${c.provider} ${key}`);
      if (existing?.status === 'sending' && Date.parse(at) - Date.parse(existing.deliveredAt) > STUCK_CLAIM_MS) {
        // An attempt that never finished (the process stopped mid-send). Whether it reached the channel is
        // unknown; release its key and try again — a rare duplicate beats a lost alert.
        await deps.repos.notifications.settle(ws.id, { ...existing, status: 'failed', dedupeKey: `${key}#interrupted@${existing.deliveredAt}`, detail: line('an earlier attempt did not finish; delivery unknown — retried') });
      }
      const claim: NotificationRecord = { id: uniqueId(`ntf-${c.id}`, at), channel: c.provider, dedupeKey: key, deliveredAt: at, status: 'sending', detail: line('sending') };
      if (!(await deps.repos.notifications.add(ws.id, claim))) {
        out.duplicates++;
        continue;
      }
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
      // Settle the claim. A failure releases the key, so the same message is tried again next time.
      await deps.repos.notifications.settle(ws.id, { ...claim, status, dedupeKey: status === 'delivered' ? key : `${key}#failed@${at}`, detail: line(detail) });
      if (status === 'delivered') out.delivered++;
      else out.failed++;
    }
  }
  return out;
}
