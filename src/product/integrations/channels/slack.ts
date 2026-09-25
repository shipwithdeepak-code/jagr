import { z } from 'zod';
import type { ChannelFactory } from '../../app/notifications';
import type { NotificationChannel, NotificationMessage } from '../../ports/notify';
import type { HttpClient } from '../../ports/http';
import type { Clock } from '../../ports/clock';
import { restrictHosts, requestJson } from '../connectors/http';
import { ConnectorConfigError } from '../connectors/errors';
import type { ConnectorCheck } from '../connectors/types';
import { redactPersonalData } from '../../lib/redact';

/**
 * Slack — outbound only. Renders a NotificationMessage as Block Kit and posts it with
 * `chat.postMessage` (bot token, scope `chat:write`) to one configured channel.
 *
 * Jagr never reads Slack, and nothing is decided in Slack: messages carry link buttons back to Jagr
 * only (no interactive actions, no interactivity endpoint), so an approval request is decided in Jagr
 * by a signed-in member. Links carry no tokens; opening one requires signing in.
 */

export const SlackConfig = z.object({ channel: z.string().regex(/^[CGD][A-Z0-9]{6,20}$/, { message: 'must be a Slack channel id, e.g. C0123456789' }) }).strict();
export type SlackConfig = z.infer<typeof SlackConfig>;

const HOST = 'slack.com';
const ATTENTION: Record<string, string> = { CRITICAL: '🔴 CRITICAL', HIGH: '🟠 HIGH', MEDIUM: '🟡 MEDIUM', LOW: '⚪ LOW' };
const KIND: Record<NotificationMessage['kind'], string> = {
  investigation_confirmed: 'Investigation',
  approval_requested: 'Approval requested',
  morning_brief: 'Morning brief',
  resolved: 'Resolved',
};

/** Slack mrkdwn escaping: only &, < and > are control characters. */
export const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (s: string, max: number) => {
  const t = escapeMrkdwn(redactPersonalData(s));
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const bullets = (items: string[]) => items.map((i) => `• ${text(i, 400)}`).join('\n');

type Block = Record<string, unknown>;

/** The Block Kit payload for a message (pure; snapshot-tested). */
export function renderSlack(m: NotificationMessage): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: redactPersonalData(m.title).slice(0, 150), emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: [KIND[m.kind], m.attention ? `Attention: ${ATTENTION[m.attention] ?? m.attention}` : undefined].filter(Boolean).join(' · ') }] },
    { type: 'section', text: { type: 'mrkdwn', text: text(m.summary, 2900) } },
  ];
  if (m.observed.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${m.kind === 'morning_brief' ? 'Items' : 'Observed'}*\n${bullets(m.observed)}`.slice(0, 2900) } });
  if (m.inferred.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Inferred — not proven*\n${bullets(m.inferred)}`.slice(0, 2900) } });
  if (m.unknown.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Unknown*\n${bullets(m.unknown)}`.slice(0, 2900) } });
  if (m.approval)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Approval needed (${m.approval.risk} risk):* ${text(m.approval.what, 500)}\nDecide in Jagr — nothing is approved from Slack.` } });
  const links = m.links.filter((l) => /^https:\/\//.test(l.href)).slice(0, 5);
  if (links.length) blocks.push({ type: 'actions', elements: links.map((l, i) => ({ type: 'button', text: { type: 'plain_text', text: l.label.slice(0, 75) }, url: l.href, action_id: `open_${i}` })) });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent by Jagr. Correlation is not causation: Jagr reports what the connected sources show.' }] });
  return { text: `${KIND[m.kind]}: ${redactPersonalData(m.title)}`.slice(0, 300), blocks };
}

interface PostResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

export function slackChannel(token: string, http: HttpClient, clock: Clock): NotificationChannel {
  const safe = restrictHosts(http, [HOST], 'slack');
  return {
    kind: 'slack',
    async send(m, target) {
      const { text: fallback, blocks } = renderSlack(m);
      const at = clock.now();
      try {
        const r = await requestJson<PostResponse>(safe, 'slack', 'Slack', `https://${HOST}/api/chat.postMessage`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ channel: target.address, text: fallback, blocks, unfurl_links: false, unfurl_media: false }),
        });
        // Slack answers 200 with ok:false for API errors (channel_not_found, not_in_channel, invalid_auth…).
        if (!r?.ok) return { channel: 'slack', dedupeKey: m.dedupeKey, deliveredAt: at, status: 'failed', detail: `Slack refused the message (${String(r?.error ?? 'unknown_error').replace(/[^a-z_]/g, '').slice(0, 40)})` };
        return { channel: 'slack', dedupeKey: m.dedupeKey, deliveredAt: at, status: 'delivered', externalId: r.ts };
      } catch (e) {
        return { channel: 'slack', dedupeKey: m.dedupeKey, deliveredAt: at, status: 'failed', detail: (e as Error).message.slice(0, 200) };
      }
    },
  };
}

/** Builds the Slack channel for a workspace connection (config: channel id; secret: bot token). */
export const slackChannelFactory: ChannelFactory = (conn, ctx) => {
  const parsed = SlackConfig.safeParse(conn.config);
  if (!parsed.success) throw new ConnectorConfigError(`Slack configuration is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}.`);
  const s = ctx.secret;
  const token = s?.kind === 'api_key' ? s.fields.botToken : s?.kind === 'oauth' ? s.accessToken : undefined;
  if (!token) throw new ConnectorConfigError('Slack has no stored bot token.');
  return { channel: slackChannel(token, ctx.http, ctx.clock), target: { address: parsed.data.channel }, check: () => slackCheck(token, ctx.http) };
};

/**
 * Verify a bot token with `auth.test` (sends nothing). Keeps only the Slack workspace name. Whether the
 * bot can post to the configured channel is known on the first delivery (delivery log).
 */
export async function slackCheck(token: string, http: HttpClient): Promise<ConnectorCheck> {
  try {
    const r = await requestJson<{ ok: boolean; team?: string; error?: string }>(restrictHosts(http, [HOST], 'slack'), 'slack', 'Slack', `https://${HOST}/api/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' } });
    if (r?.ok) return { state: 'connected', detail: 'Slack bot token verified; channel access is confirmed on the first delivery', account: r.team ? redactPersonalData(r.team).slice(0, 80) : undefined };
    const code = String(r?.error ?? 'unknown_error').replace(/[^a-z_]/g, '').slice(0, 40);
    return { state: ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired'].includes(code) ? 'needs_reconnect' : 'error', detail: `Slack refused the token (${code})` };
  } catch (e) {
    return { state: (e as Error).name === 'ConnectorAuthError' ? 'needs_reconnect' : 'unavailable', detail: (e as Error).message.slice(0, 200) };
  }
}
