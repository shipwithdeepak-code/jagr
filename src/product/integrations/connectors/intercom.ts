import { z } from 'zod';
import type { FeedbackItem, TimeWindow } from '../../roles/types.js';
import type { ConnectorContext, ConnectorDescriptor, ReadStamp } from './types.js';
import { requestJson } from './http.js';
import { provenance } from './runtime.js';
import { plainText, redactPersonalData } from './redact.js';
import { ProviderUnavailableError } from '../types.js';

/**
 * Intercom — FeedbackSource: customer-started support conversations. REST API (version 2.11),
 * read-only, with an access token (scope: read conversations).
 *
 *   POST /conversations/search     conversations created in the window (cursor-paginated)
 *   GET  /me                       credential check (only the workspace name is kept)
 *
 * Personal data: the customer's first message is converted to plain text and redacted (email
 * addresses, phone numbers, links, card numbers, credential-like strings) HERE — before it is stored,
 * shown as evidence, exported or sent to an AI planner. Author identity (name, email, id) is never
 * read into a record. Names written inside the message are not detected.
 *
 * Only conversations a customer started (author type user / lead / contact) are feedback; outbound
 * admin messages and bot-started conversations are not.
 */

export const IntercomConfig = z
  .object({
    region: z.enum(['us', 'eu', 'au']).default('us'),
    /** Intercom workspace (app) id, for deep links into the inbox. */
    appId: z.string().regex(/^[a-z0-9]{4,20}$/).optional(),
    maxPages: z.number().int().min(1).max(10).default(4),
  })
  .strict();
export type IntercomConfig = z.infer<typeof IntercomConfig>;

const API = { us: 'api.intercom.io', eu: 'api.eu.intercom.io', au: 'api.au.intercom.io' } as const;
const APP = { us: 'app.intercom.com', eu: 'app.eu.intercom.com', au: 'app.au.intercom.com' } as const;
const CUSTOMER = new Set(['user', 'lead', 'contact']);

interface Conversation {
  id: string;
  created_at: number;
  source?: { subject?: string | null; body?: string | null; author?: { type?: string } };
  tags?: { tags?: { name: string }[] };
  conversation_rating?: { rating?: number | null } | null;
}
interface SearchResponse {
  conversations?: Conversation[];
  pages?: { next?: { starting_after?: string } | null };
}

class IntercomReader {
  constructor(private readonly ctx: ConnectorContext<IntercomConfig>) {}

  private get headers() {
    const s = this.ctx.secret;
    if (s.kind === 'oauth' && s.accessToken) return this.with(s.accessToken);
    if (s.kind !== 'api_key' || !s.fields.token) throw new ProviderUnavailableError('intercom', 'error', 'Intercom credential is incomplete (an access token is required).');
    return this.with(s.fields.token);
  }
  private with(token: string) {
    return { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'intercom-version': '2.11' };
  }
  request<T>(path: string, body?: unknown) {
    return requestJson<T>(this.ctx.http, 'intercom', 'Intercom', `https://${API[this.ctx.config.region]}${path}`, { method: body ? 'POST' : 'GET', headers: this.headers, body: body ? JSON.stringify(body) : undefined });
  }

  async feedback(window: TimeWindow): Promise<FeedbackItem[]> {
    const from = Math.floor(Date.parse(window.start) / 1000);
    const to = Math.floor(Date.parse(window.end) / 1000);
    const stamp: ReadStamp = { connectionId: this.ctx.connection.id, provider: 'intercom', source: 'intercom', fetchedAt: this.ctx.clock.now() };
    const out: FeedbackItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.ctx.config.maxPages; page++) {
      const res = await this.request<SearchResponse>('/conversations/search', {
        query: { operator: 'AND', value: [{ field: 'created_at', operator: '>', value: from - 1 }, { field: 'created_at', operator: '<', value: to + 1 }] },
        pagination: { per_page: 50, ...(cursor ? { starting_after: cursor } : {}) },
        sort: { field: 'created_at', order: 'ascending' },
      });
      if (!res || !Array.isArray(res.conversations)) throw new ProviderUnavailableError('intercom', 'error', 'Intercom returned conversations Jagr could not read.');
      for (const c of res.conversations) {
        const item = this.map(c, stamp, window);
        if (item) out.push(item);
      }
      cursor = res.pages?.next?.starting_after ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  private map(c: Conversation, stamp: ReadStamp, window: TimeWindow): FeedbackItem | undefined {
    if (!CUSTOMER.has(c.source?.author?.type ?? '')) return undefined;
    const createdAt = new Date(c.created_at * 1000).toISOString();
    if (createdAt < window.start || createdAt > window.end) return undefined;
    const text = redactPersonalData(plainText(c.source?.body ?? '')).slice(0, 1000);
    const subject = redactPersonalData(plainText(c.source?.subject ?? ''));
    const title = (subject || text.split('\n')[0] || 'Support conversation').slice(0, 120);
    const tags = (c.tags?.tags ?? []).map((t) => t.name.toLowerCase()).slice(0, 20);
    const r = c.conversation_rating?.rating;
    const cfg = this.ctx.config;
    const url = cfg.appId ? `https://${APP[cfg.region]}/a/inbox/${cfg.appId}/inbox/conversation/${encodeURIComponent(c.id)}` : `https://${APP[cfg.region]}/`;
    return {
      id: `intercom-${c.id}`,
      source: 'intercom',
      channel: 'support',
      ...(r && r >= 1 && r <= 5 ? { rating: r as FeedbackItem['rating'] } : {}),
      title,
      text,
      tags,
      createdAt,
      ref: { provider: 'intercom', kind: 'review', id: c.id },
      provenance: provenance(stamp, c.id, createdAt, url),
    };
  }
}

export const intercomConnector: ConnectorDescriptor<IntercomConfig> = {
  id: 'intercom',
  source: 'intercom',
  name: 'Intercom',
  roles: ['feedback'],
  config: IntercomConfig as unknown as z.ZodType<IntercomConfig>,
  secretKinds: ['api_key', 'oauth'],
  credentialFields: [{ key: 'token', label: 'Access token' }],
  hosts: (cfg) => [API[cfg.region]],
  build(ctx) {
    const r = new IntercomReader(ctx);
    return { feedback: { getFeedback: ({ window }) => r.feedback(window) } };
  },
  async check(ctx) {
    const me = await new IntercomReader(ctx).request<{ app?: { name?: string } }>('/me');
    return { state: 'connected', detail: `Intercom (${ctx.config.region.toUpperCase()})`, account: me?.app?.name ? redactPersonalData(me.app.name).slice(0, 80) : undefined };
  },
};
