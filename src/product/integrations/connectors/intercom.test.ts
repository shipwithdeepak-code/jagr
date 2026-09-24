import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import type { HttpRequest } from '../../ports/http';
import { manualClock } from '../../ports/clock';
import { connectorContract, scriptedHttp, type Reply } from '../../testkit/connectorContract';
import { buildPlannerPrompt, type PlannerInput } from '../../agent/plannerPrompt';
import { intercomConnector } from './intercom';
import { connectorFactory } from './runtime';

/**
 * Intercom connector against responses in the REST API's documented shape (conversations search, /me).
 * Synthesised fixtures, not a live recording — `npm run eval:connectors` is the live check.
 */

const NOW = '2026-09-25T06:00:00.000Z';
const window = { start: '2026-09-24T06:00:00.000Z', end: NOW };
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const CONVERSATIONS = [
  {
    id: '9001',
    created_at: unix('2026-09-25T02:40:00Z'),
    source: { subject: '', body: '<p>I can&#39;t pay — the checkout button does nothing!</p><p>Email me at maria.lopez@example.org or call +1 415 555 0132.</p>', author: { type: 'user', name: 'Maria Lopez', email: 'maria.lopez@example.org' } },
    tags: { tags: [{ name: 'Checkout' }, { name: 'Bug' }] },
    conversation_rating: null,
  },
  {
    id: '9002',
    created_at: unix('2026-09-25T03:05:00Z'),
    source: { subject: 'Payment failed', body: '<p>Card 4242 4242 4242 4242 declined three times at checkout.</p>', author: { type: 'lead', email: 'anon@example.org' } },
    tags: { tags: [] },
    conversation_rating: { rating: 1 },
  },
  // Outbound admin message: not customer feedback.
  { id: '9003', created_at: unix('2026-09-25T03:10:00Z'), source: { subject: 'Your order', body: '<p>Thanks for your order!</p>', author: { type: 'admin', email: 'support@acme.test' } }, tags: { tags: [] } },
  // After the run's "as of" time.
  { id: '9004', created_at: unix('2026-09-25T07:00:00Z'), source: { body: '<p>Later complaint</p>', author: { type: 'user' } }, tags: { tags: [] } },
];

export const intercomRoute = (u: URL, init?: HttpRequest): Reply | undefined => {
  if (u.hostname !== 'api.intercom.io') return undefined;
  if (u.pathname === '/me') return { body: { type: 'admin', email: 'owner@acme.test', app: { name: 'Acme Support' } } };
  if (u.pathname === '/conversations/search' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { pagination?: { starting_after?: string } };
    return body.pagination?.starting_after
      ? { body: { type: 'conversation.list', conversations: CONVERSATIONS.slice(2), pages: { next: null } } }
      : { body: { type: 'conversation.list', conversations: CONVERSATIONS.slice(0, 2), pages: { next: { starting_after: 'cursor-2' } } } };
  }
  return undefined;
};

export const intercomConnection: Connection = {
  id: 'owner-intercom',
  workspaceId: 'ws-1',
  source: 'intercom',
  provider: 'intercom',
  roles: ['feedback'],
  authKind: 'owner_env',
  state: 'connected',
  detail: 'Intercom',
  config: { region: 'us', appId: 'abc123xy' },
  updatedAt: '2026-09-24T00:00:00.000Z',
};
export const intercomSecret = { kind: 'api_key' as const, fields: { token: 'dG9rOjEyMzQ1Njc4OTA6aW50ZXJjb20=' } };

connectorContract({
  name: 'Intercom',
  descriptor: intercomConnector,
  connection: intercomConnection,
  secret: intercomSecret,
  otherSecret: { kind: 'api_key', fields: { token: 'dG9rOjk4NzY1NDMyMTA6b3RoZXI=' } },
  route: intercomRoute,
  window,
  expectRecords: { feedback: 2 },
  invalidConfigs: [{ region: 'moon' }, { region: 'us', appId: 'x/../../evil' }, { region: 'us', host: 'evil.example.com' }],
});

const build = () => connectorFactory(intercomConnector)(intercomConnection, { secret: intercomSecret, http: scriptedHttp(intercomRoute).http, clock: manualClock(NOW) });

describe('Intercom mapping and personal data', () => {
  it('customer-started conversations only, in window, paginated; support channel; ratings kept', async () => {
    const items = await build().feedback!.getFeedback({ window });
    expect(items.map((i) => [i.id, i.channel, i.rating ?? null])).toEqual([
      ['intercom-9001', 'support', null],
      ['intercom-9002', 'support', 1],
    ]);
    expect(items[0].tags).toEqual(['checkout', 'bug']);
    expect(items[0].provenance.url).toBe('https://app.intercom.com/a/inbox/abc123xy/inbox/conversation/9001');
  });

  it('removes contact details and card numbers before anything is stored; keeps the complaint', async () => {
    const items = await build().feedback!.getFeedback({ window });
    const text = JSON.stringify(items);
    expect(text).not.toMatch(/maria|lopez|555 0132|4242|anon@|example\.org/i);
    expect(items[0].text).toContain("I can't pay — the checkout button does nothing!");
    expect(items[0].text).toContain('[email removed]');
    expect(items[1].text).toContain('[number removed]');
  });

  it('check() keeps the workspace name, never the admin email', async () => {
    const { checkConnector } = await import('./runtime');
    const r = await checkConnector(intercomConnector, intercomConnection, { secret: intercomSecret, http: scriptedHttp(intercomRoute).http, clock: manualClock(NOW) });
    expect(r).toMatchObject({ state: 'connected', account: 'Acme Support' });
    expect(JSON.stringify(r)).not.toContain('owner@acme.test');
  });
});

describe('AI planner prompt', () => {
  it('never carries personal data, even if a statement slipped through unredacted', () => {
    const input: PlannerInput = {
      investigationId: 'i1',
      pass: 1,
      signal: { key: 'metric:checkout_conversion', label: 'Checkout conversion', magnitude: '−25%' },
      area: 'checkout',
      budget: { used: 1, max: 9 },
      hypotheses: [],
      evidence: [{ source: 'intercom', direction: 'corroborating', statement: 'Customer jane@example.org (+44 20 7946 0958) says checkout fails' }],
      options: [],
    };
    const prompt = buildPlannerPrompt(input);
    expect(prompt).not.toMatch(/jane@|7946/);
    expect(prompt).toContain('checkout fails');
    expect(prompt).toContain('−25%');
  });
});
