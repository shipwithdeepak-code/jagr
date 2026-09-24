import { describe, expect, it } from 'vitest';
import { JiraCloudAdapter, jqlDate, normaliseJiraDate } from './integrations/jiraCloud';
import { ProviderUnavailableError } from './integrations/types';

type Call = { url: string; init?: RequestInit };

function mockFetch(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = routes({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const window = { start: '2026-09-23T18:00:00.000Z', end: '2026-09-24T08:00:00.000Z' };
const cfg = { baseUrl: 'https://acme.atlassian.net/', projectKey: 'PAY', authorization: 'Basic dGVzdDp0ZXN0' };

const issue = (key: string, created: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: 'Checkout spinner never completes', created, issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: ['ios'], versions: [{ name: '4.8.1' }], reporter: { displayName: 'QA' }, ...extra },
});

describe('Jira Cloud connector', () => {
  it('searches issues with JQL, follows pagination and maps to the normalised contract', async () => {
    const { f, calls } = mockFetch(({ init }) => {
      const body = JSON.parse(String(init?.body));
      return body.nextPageToken
        ? { status: 200, body: { issues: [issue('PAY-513', '2026-09-23T20:05:00.000+0000', { issuetype: { name: 'Incident' }, priority: { name: 'Highest' } })], isLast: true } }
        : { status: 200, body: { issues: [issue('PAY-512', '2026-09-23T19:20:00.000+0000'), issue('PAY-400', '2026-09-23T17:59:00.000+0000')], nextPageToken: 'p2', isLast: false } };
    });
    const jira = new JiraCloudAdapter({ ...cfg, fetch: f });
    const issues = await jira.getIssues(window);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(cfg.authorization);
    expect(JSON.parse(String(calls[0].init?.body)).jql).toBe('project = "PAY" AND created >= "2026/09/23 18:00" AND created <= "2026/09/24 08:00" ORDER BY created ASC');
    expect(JSON.parse(String(calls[1].init?.body)).nextPageToken).toBe('p2');

    // PAY-400 falls outside the exact window and is dropped.
    expect(issues.map((i) => i.id)).toEqual(['PAY-512', 'PAY-513']);
    expect(issues[0]).toMatchObject({ provider: 'jira', type: 'Bug', priority: 'High', component: 'Checkout', area: 'checkout', affectsVersion: '4.8.1', createdAt: '2026-09-23T19:20:00.000Z' });
    expect(issues[1]).toMatchObject({ type: 'Incident', priority: 'Highest' });
  });

  it('maps released versions with day precision, and says so', async () => {
    const { f, calls } = mockFetch(() => ({
      status: 200,
      body: [
        { id: '10001', name: '4.8.1', released: true, releaseDate: '2026-09-23', description: 'Payment sheet refactor' },
        { id: '10002', name: '4.9.0', released: false },
        { id: '10000', name: '4.8.0', released: true, releaseDate: '2026-09-10' },
      ],
    }));
    const jira = new JiraCloudAdapter({ ...cfg, fetch: f });
    const releases = await jira.getReleases(window);
    expect(calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/project/PAY/versions');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ id: 'jira-ver-10001', version: '4.8.1', releasedAt: '2026-09-23T00:00:00.000Z' });
    expect(releases[0].notes).toMatch(/precision: day/);
  });

  it.each([
    [401, 'error'],
    [403, 'error'],
    [429, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('turns HTTP %i into a %s gap, never an empty result', async (status, state) => {
    const { f } = mockFetch(() => ({ status }));
    const jira = new JiraCloudAdapter({ ...cfg, fetch: f });
    const err = await jira.getIssues(window).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.state).toBe(state);
  });

  it('treats a network failure as unavailable', async () => {
    const f = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = await new JiraCloudAdapter({ ...cfg, fetch: f }).getReleases(window).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.state).toBe('unavailable');
  });

  it('is honest when not configured: no calls, an unavailable connection, real links', async () => {
    const { f, calls } = mockFetch(() => ({ status: 200, body: [] }));
    const jira = new JiraCloudAdapter({ baseUrl: 'https://acme.atlassian.net', projectKey: 'PAY', fetch: f });
    expect(jira.connection().state).toBe('unavailable');
    expect(jira.connection().detail).toMatch(/not configured/);
    await expect(jira.getIssues(window)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toHaveLength(0);
    expect(jira.link({ provider: 'jira', kind: 'issue', id: 'PAY-512' }).externalUrl).toBe('https://acme.atlassian.net/browse/PAY-512');
    expect(jira.link({ provider: 'jira', kind: 'issue', id: 'PAY-512' }).simulated).toBe(false);
  });

  it('normalises Jira timestamps and JQL dates', () => {
    expect(normaliseJiraDate('2026-09-23T21:20:00.000+0200')).toBe('2026-09-23T19:20:00.000Z');
    expect(jqlDate('2026-09-23T07:05:00.000Z')).toBe('2026/09/23 07:05');
  });
});
