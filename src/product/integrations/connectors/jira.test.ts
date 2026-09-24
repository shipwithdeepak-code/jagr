import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import type { HttpRequest } from '../../ports/http';
import { manualClock } from '../../ports/clock';
import { connectorContract, scriptedHttp, type Reply } from '../../testkit/connectorContract';
import { jiraConnector } from './jira';
import { connectorFactory } from './runtime';

/**
 * Jira connector against responses in Jira Cloud REST v3's documented shape (search/jql, project
 * versions, project). Synthesised fixtures, not a live recording — `npm run eval:connectors` is the live check.
 */

const NOW = '2026-09-25T06:00:00.000Z';
const window = { start: '2026-09-24T06:00:00.000Z', end: NOW };

const issue = (key: string, created: string, summary: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: { summary, created, issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: ['ios'], versions: [{ name: '2.3.0' }], reporter: { displayName: 'Jo Customer', emailAddress: 'jo@acme.test' }, ...extra },
});

function search(init?: HttpRequest): Reply {
  const body = JSON.parse(String(init?.body ?? '{}')) as { nextPageToken?: string };
  return body.nextPageToken
    ? { body: { issues: [issue('SHOP-102', '2026-09-25T03:20:00.000+0000', 'Payment sheet spins forever', { issuetype: { name: 'Incident' }, priority: { name: 'Highest' } })], isLast: true } }
    : {
        body: {
          issues: [
            issue('SHOP-101', '2026-09-25T02:30:00.000+0000', 'Checkout button unresponsive — reported by jo@acme.test'),
            issue('SHOP-100', '2026-09-24T05:00:00.000+0000', 'Old issue, before the window'),
          ],
          nextPageToken: 'p2',
          isLast: false,
        },
      };
}

const route = (u: URL, init?: HttpRequest): Reply | undefined => {
  if (u.hostname !== 'acme.atlassian.net') return undefined;
  if (u.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') return search(init);
  if (u.pathname === '/rest/api/3/project/SHOP/versions')
    return {
      body: [
        { id: '10010', name: '2.3.0', released: true, releaseDate: '2026-09-25', description: 'Checkout v2' },
        { id: '10011', name: '2.4.0', released: false },
        { id: '10009', name: '2.2.0', released: true, releaseDate: '2026-09-02' },
      ],
    };
  if (u.pathname === '/rest/api/3/project/SHOP') return { body: { key: 'SHOP', name: 'Shop' } };
  return undefined;
};

const connection: Connection = {
  id: 'owner-jira',
  workspaceId: 'ws-1',
  source: 'jira',
  provider: 'jira',
  roles: ['work_items', 'changes'],
  authKind: 'owner_env',
  state: 'connected',
  detail: 'Jira',
  config: { site: 'https://acme.atlassian.net', project: 'SHOP' },
  updatedAt: '2026-09-24T00:00:00.000Z',
};
const secret = { kind: 'api_key' as const, fields: { email: 'svc-jagr@acme.test', apiToken: 'ATATT3xFfGF0aaaaaaaaaaaa' } };

connectorContract({
  name: 'Jira',
  descriptor: jiraConnector,
  connection,
  secret,
  otherSecret: { kind: 'api_key', fields: { email: 'other-svc@acme.test', apiToken: 'ATATT3xFfGF0bbbbbbbbbbbb' } },
  route,
  window,
  expectRecords: { work_items: 2, changes: 1 },
  invalidConfigs: [
    { site: 'https://evil.example.com', project: 'SHOP' },
    { site: 'http://acme.atlassian.net', project: 'SHOP' },
    { site: 'https://acme.atlassian.net', project: 'shop; drop' },
    { site: 'https://acme.atlassian.net.evil.com', project: 'SHOP' },
  ],
});

const build = () => connectorFactory(jiraConnector)(connection, { secret, http: scriptedHttp(route).http, clock: manualClock(NOW) });

describe('Jira mapping', () => {
  it('issues → work items: paginated, in-window, deep-linked, no reporter identity, customer emails redacted', async () => {
    const items = await build().work_items!.getWorkItems({ window });
    expect(items.map((i) => [i.id, i.type, i.priority, i.area])).toEqual([
      ['SHOP-101', 'bug', 'high', 'checkout'],
      ['SHOP-102', 'incident', 'critical', 'checkout'],
    ]);
    expect(items[0].provenance.url).toBe('https://acme.atlassian.net/browse/SHOP-101');
    const text = JSON.stringify(items);
    expect(text).not.toMatch(/jo@acme\.test|Jo Customer/);
  });

  it('released versions → planned-timing changes (day precision), never timing evidence', async () => {
    const changes = await build().changes!.getChanges({ window });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'release', timing: 'planned', version: '2.3.0', at: '2026-09-25T00:00:00.000Z' });
    expect(changes[0].notes).toMatch(/precision: day/);
    expect(changes[0].provenance.url).toBe('https://acme.atlassian.net/projects/SHOP/versions/10010');
  });

  it('check() fails closed when the project is not visible to the account', async () => {
    const { checkConnector } = await import('./runtime');
    const http = scriptedHttp((u) => (u.pathname === '/rest/api/3/project/SHOP' ? { body: { key: 'OTHER' } } : undefined)).http;
    expect((await checkConnector(jiraConnector, connection, { secret, http, clock: manualClock(NOW) })).state).toBe('error');
  });
});
