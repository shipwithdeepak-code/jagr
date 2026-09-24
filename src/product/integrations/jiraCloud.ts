import type { SourceConnection, SourceLink, SourceRef } from '../types';
import { classifyText } from '../catalog';
import { PROVIDERS } from './adapters';
import { ProviderUnavailableError, type Capability, type IntegrationAdapter, type IssueRecord, type MetricSeries, type ReleaseRecord, type ReviewRecord, type SourceEvent, type TimeWindow } from './types';

import type { HttpClient, HttpRequest, HttpResponse } from '../ports/http';
/**
 * A real Jira Cloud connector (REST API v3) behind the same IntegrationAdapter contract as the
 * simulated sources.
 *
 * It must run server-side: Jira Cloud does not allow browser CORS calls with API tokens, and a
 * token in the client bundle would be readable by anyone. The browser build of Jagr therefore
 * never instantiates this with credentials — it shows Jira as "implemented, not configured".
 *
 * Endpoints used:
 *   POST /rest/api/3/search/jql                    — issues created in a window (token-paginated)
 *   GET  /rest/api/3/project/{key}/versions        — releases (fix versions)
 *
 * Known limitations, surfaced rather than hidden:
 *   - Jira versions carry a release DATE, not a time. Releases from this connector are marked
 *     `precision: 'day'` in their notes; the investigator must not claim minute-level timing from them.
 *   - JQL dates are interpreted in the API user's profile timezone. Use a service account set to UTC.
 */

export interface JiraCloudConfig {
  /** e.g. https://your-company.atlassian.net */
  baseUrl: string;
  projectKey: string;
  /** Pre-built Authorization header value, e.g. `Basic base64(email:token)`. Supplied by the server. */
  authorization?: string;
  /** Outbound HTTP, injected by the host (the core never uses a global fetch). */
  http: HttpClient;
  maxPages?: number;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    created: string;
    issuetype?: { name?: string };
    priority?: { name?: string };
    components?: { name: string }[];
    labels?: string[];
    versions?: { name: string }[];
    reporter?: { displayName?: string };
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface JiraVersion {
  id: string;
  name: string;
  released?: boolean;
  releaseDate?: string;
  description?: string;
}

const FIELDS = ['summary', 'created', 'issuetype', 'priority', 'components', 'labels', 'versions', 'reporter'];

/** Jira returns offsets like +0000; normalise to ISO so Date.parse is reliable everywhere. */
export function normaliseJiraDate(s: string): string {
  return new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString();
}

/** JQL datetime literal, "yyyy/MM/dd HH:mm" (interpreted in the API user's timezone — use UTC). */
export function jqlDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const TYPE: Record<string, IssueRecord['type']> = { bug: 'Bug', incident: 'Incident' };
const PRIORITY: Record<string, IssueRecord['priority']> = { highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Low' };

export function mapJiraIssue(i: JiraIssue): IssueRecord {
  const f = i.fields;
  const components = (f.components ?? []).map((c) => c.name);
  const labels = f.labels ?? [];
  return {
    id: i.key,
    provider: 'jira',
    title: f.summary,
    type: TYPE[(f.issuetype?.name ?? '').toLowerCase()] ?? 'Task',
    priority: PRIORITY[(f.priority?.name ?? '').toLowerCase()] ?? 'Medium',
    component: components[0] ?? '',
    area: classifyText([f.summary, ...components, ...labels].join(' '))[0] ?? 'general',
    labels,
    affectsVersion: f.versions?.[0]?.name,
    reporter: f.reporter?.displayName ?? 'Unknown',
    createdAt: normaliseJiraDate(f.created),
  };
}

export function mapJiraVersion(v: JiraVersion): ReleaseRecord | undefined {
  if (!v.released || !v.releaseDate) return undefined;
  return {
    id: `jira-ver-${v.id}`,
    provider: 'jira',
    version: v.name,
    platform: 'all',
    releasedAt: new Date(`${v.releaseDate}T00:00:00Z`).toISOString(),
    notes: `${v.description ?? ''}${v.description ? ' · ' : ''}precision: day (Jira stores a release date, not a time)`,
  };
}

export class JiraCloudAdapter implements IntegrationAdapter {
  readonly provider = 'jira' as const;
  readonly name = 'Jira Cloud';
  readonly capabilities: Capability[] = ['issues', 'releases', 'events', 'changes'];
  private readonly http: HttpClient;

  constructor(private readonly cfg: JiraCloudConfig) {
    this.http = cfg.http;
  }

  configured(): boolean {
    return !!this.cfg.baseUrl && !!this.cfg.projectKey && !!this.cfg.authorization;
  }

  connection(): SourceConnection {
    return this.configured()
      ? { provider: 'jira', state: 'connected', detail: `Jira Cloud REST v3 · project ${this.cfg.projectKey}`, updatedAt: new Date().toISOString() }
      : { provider: 'jira', state: 'unavailable', detail: 'Jira Cloud connector implemented, not configured — needs server-side credentials.', updatedAt: new Date().toISOString() };
  }

  private async call<T>(path: string, init?: HttpRequest): Promise<T> {
    if (!this.configured()) throw new ProviderUnavailableError('jira', 'unavailable', 'Jira Cloud is not configured.');
    let res: HttpResponse;
    try {
      res = await this.http(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: this.cfg.authorization!, ...(init?.headers ?? {}) },
      });
    } catch (e) {
      throw new ProviderUnavailableError('jira', 'unavailable', `Jira could not be reached: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderUnavailableError('jira', 'error', `Jira rejected the credentials (${res.status}).`);
    if (res.status === 429) throw new ProviderUnavailableError('jira', 'unavailable', 'Jira rate limit reached (429).');
    if (!res.ok) throw new ProviderUnavailableError('jira', res.status >= 500 ? 'unavailable' : 'error', `Jira returned ${res.status}.`);
    return (await res.json()) as T;
  }

  async getIssues(window: TimeWindow): Promise<IssueRecord[]> {
    const jql = `project = "${this.cfg.projectKey}" AND created >= "${jqlDate(window.start)}" AND created <= "${jqlDate(window.end)}" ORDER BY created ASC`;
    const out: IssueRecord[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < (this.cfg.maxPages ?? 5); page++) {
      const body = await this.call<JiraSearchResponse>('/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify({ jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }) });
      out.push(...body.issues.map(mapJiraIssue));
      nextPageToken = body.nextPageToken;
      if (body.isLast !== false || !nextPageToken) break;
    }
    // JQL is minute-precision; filter to the exact window so the contract matches the simulated adapter.
    return out.filter((i) => i.createdAt >= window.start && i.createdAt <= window.end);
  }

  async getReleases(window: TimeWindow): Promise<ReleaseRecord[]> {
    const versions = await this.call<JiraVersion[]>(`/rest/api/3/project/${encodeURIComponent(this.cfg.projectKey)}/versions`);
    const startDay = window.start.slice(0, 10);
    const endDay = window.end.slice(0, 10);
    // Day precision: include any version released on a day the window touches.
    return versions.map(mapJiraVersion).filter((r): r is ReleaseRecord => !!r && r.releasedAt.slice(0, 10) >= startDay && r.releasedAt.slice(0, 10) <= endDay);
  }

  async getChanges(window: TimeWindow): Promise<ReleaseRecord[]> {
    return this.getReleases(window);
  }

  async getMetrics(_ids: string[], _window: TimeWindow): Promise<MetricSeries[]> {
    return [];
  }

  async getReviews(_window: TimeWindow): Promise<ReviewRecord[]> {
    return [];
  }

  async getEvents(window: TimeWindow): Promise<SourceEvent[]> {
    const [issues, releases] = await Promise.all([this.getIssues(window), this.getReleases(window)]);
    return [
      ...issues.map((i): SourceEvent => ({ at: i.createdAt, provider: 'jira', kind: 'issue', title: `${i.id} ${i.title}`, ref: { provider: 'jira', kind: 'issue', id: i.id } })),
      ...releases.map((r): SourceEvent => ({ at: r.releasedAt, provider: 'jira', kind: 'release', title: `Release ${r.version}`, ref: { provider: 'jira', kind: 'release', id: r.id } })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }

  link(ref: SourceRef, label?: string): SourceLink {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const externalUrl = ref.kind === 'issue' ? `${base}/browse/${ref.id}` : `${base}/projects/${this.cfg.projectKey}/versions/${ref.id.replace(/^jira-ver-/, '')}`;
    return { label: label ?? `Open ${PROVIDERS.jira.short}`, provider: 'jira', href: `/sources/jira/${ref.kind}/${ref.id}`, externalUrl, simulated: false, ref };
  }
}
