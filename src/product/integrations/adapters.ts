import type { ProviderId, SourceConnection, SourceLink, SourceRef } from '../types';
import {
  ProviderUnavailableError,
  type Capability,
  type EmailChannel,
  type IntegrationAdapter,
  type IssueRecord,
  type MetricSeries,
  type ReleaseRecord,
  type ReviewRecord,
  type SourceEvent,
  type TimeWindow,
} from './types';
import { BUCKET_MIN, type World } from './world';

/**
 * Simulated adapters for Jira, GA4, App Store Connect and Google Play.
 * They behave like real APIs: windowed queries, only data that exists "as of" the query,
 * and hard failures when the connection is unavailable or erroring. They never fabricate.
 */

export const PROVIDERS: Record<ProviderId, { name: string; short: string; capabilities: Capability[]; externalBase: string; realApi: string }> = {
  jira: { name: 'Jira', short: 'Jira', capabilities: ['issues', 'releases', 'events', 'changes'], externalBase: 'https://your-company.atlassian.net', realApi: 'Jira Cloud REST API v3' },
  ga4: { name: 'Google Analytics 4', short: 'Analytics', capabilities: ['metrics'], externalBase: 'https://analytics.google.com/analytics/web', realApi: 'GA4 Data API (runReport)' },
  app_store: { name: 'App Store Connect', short: 'App Store', capabilities: ['metrics', 'releases', 'reviews', 'events', 'changes'], externalBase: 'https://appstoreconnect.apple.com', realApi: 'App Store Connect API' },
  google_play: { name: 'Google Play Console', short: 'Play Store', capabilities: ['metrics', 'releases', 'reviews', 'events', 'changes'], externalBase: 'https://play.google.com/console', realApi: 'Play Developer Reporting API' },
  email: { name: 'Email', short: 'Email', capabilities: ['send_email'], externalBase: 'mailto:', realApi: 'SMTP / transactional email provider' },
};

export function sourceHref(ref: SourceRef): string {
  return `/sources/${ref.provider}/${ref.kind}/${encodeURIComponent(ref.id)}`;
}

export function externalUrl(ref: SourceRef): string {
  const base = PROVIDERS[ref.provider].externalBase;
  switch (ref.provider) {
    case 'jira':
      return ref.kind === 'issue' ? `${base}/browse/${ref.id}` : `${base}/projects/APP/versions`;
    case 'ga4':
      return `${base}/#/reports/explorer?metric=${encodeURIComponent(ref.id.replace('ga4.', ''))}`;
    case 'app_store':
      return ref.kind === 'review' ? `${base}/apps/tempo/appstore/activity/ratings` : `${base}/apps/tempo/distribution`;
    case 'google_play':
      return ref.kind === 'review' ? `${base}/app/tempo/user-feedback/reviews` : `${base}/app/tempo/vitals/crashes`;
    default:
      return base;
  }
}

export function makeLink(ref: SourceRef, label: string, simulated: boolean): SourceLink {
  return { label, provider: ref.provider, href: sourceHref(ref), externalUrl: externalUrl(ref), simulated, ref };
}

const inWindow = (at: string, w: TimeWindow) => at >= w.start && at <= w.end;

class SimulatedAdapter implements IntegrationAdapter {
  readonly name: string;
  readonly capabilities: Capability[];
  constructor(
    readonly provider: Exclude<ProviderId, 'email'>,
    private readonly world: World,
    private readonly conn: SourceConnection,
  ) {
    this.name = PROVIDERS[provider].name;
    this.capabilities = PROVIDERS[provider].capabilities;
  }

  connection() {
    return this.conn;
  }

  private guard() {
    if (this.conn.state === 'unavailable' || this.conn.state === 'error') {
      throw new ProviderUnavailableError(this.provider, this.conn.state, this.conn.detail);
    }
  }

  async getMetrics(ids: string[], window: TimeWindow): Promise<MetricSeries[]> {
    this.guard();
    if (!this.capabilities.includes('metrics')) return [];
    return this.world.metrics
      .filter((m) => m.provider === this.provider && ids.includes(m.id))
      .map((m) => ({
        ...m,
        // Only buckets that have completed by the end of the window.
        points: m.points.filter((p) => p.t >= window.start && Date.parse(p.t) + BUCKET_MIN * 60_000 <= Date.parse(window.end)),
      }));
  }

  async getIssues(window: TimeWindow): Promise<IssueRecord[]> {
    this.guard();
    if (this.provider !== 'jira') return [];
    return this.world.issues.filter((i) => inWindow(i.createdAt, window));
  }

  async getReleases(window: TimeWindow): Promise<ReleaseRecord[]> {
    this.guard();
    return this.world.releases.filter((r) => r.provider === this.provider && inWindow(r.releasedAt, window));
  }

  async getReviews(window: TimeWindow): Promise<ReviewRecord[]> {
    this.guard();
    return this.world.reviews.filter((r) => r.provider === this.provider && inWindow(r.createdAt, window));
  }

  async getChanges(window: TimeWindow): Promise<ReleaseRecord[]> {
    return this.getReleases(window);
  }

  async getEvents(window: TimeWindow): Promise<SourceEvent[]> {
    const [issues, releases, reviews] = await Promise.all([this.getIssues(window), this.getReleases(window), this.getReviews(window)]);
    return [
      ...issues.map((i): SourceEvent => ({ at: i.createdAt, provider: this.provider, kind: 'issue', title: `${i.id} ${i.title}`, ref: { provider: this.provider, kind: 'issue', id: i.id } })),
      ...releases.map((r): SourceEvent => ({ at: r.releasedAt, provider: this.provider, kind: 'release', title: `Release ${r.version}`, ref: { provider: this.provider, kind: 'release', id: r.id } })),
      ...reviews.map((r): SourceEvent => ({ at: r.createdAt, provider: this.provider, kind: 'review', title: `${r.rating}★ ${r.title}`, ref: { provider: this.provider, kind: 'review', id: r.id } })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }

  link(ref: SourceRef, label?: string): SourceLink {
    return makeLink(ref, label ?? `Open ${PROVIDERS[this.provider].short}`, this.conn.state !== 'connected');
  }
}

export class SimulatedEmailChannel implements EmailChannel {
  readonly provider = 'email' as const;
  readonly outbox: { id: string }[] = [];
  constructor(private readonly conn: SourceConnection) {}
  connection() {
    return this.conn;
  }
  async send<T extends { id: string }>(email: T): Promise<T> {
    if (this.conn.state === 'unavailable' || this.conn.state === 'error') throw new ProviderUnavailableError('email', this.conn.state, this.conn.detail);
    this.outbox.push(email);
    return email;
  }
}

export interface AdapterRegistry {
  sources: Record<Exclude<ProviderId, 'email'>, IntegrationAdapter>;
  email: SimulatedEmailChannel;
}

export function defaultConnections(at = '2026-09-23T17:55:00.000Z'): SourceConnection[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((provider) => ({
    provider,
    state: 'simulated',
    detail: provider === 'email' ? 'Simulated outbox — emails are rendered in Jagr, never delivered' : 'Deterministic fixture data (no credentials configured)',
    updatedAt: at,
  }));
}

export function createAdapters(world: World, connections: SourceConnection[]): AdapterRegistry {
  const conn = (p: ProviderId) => connections.find((c) => c.provider === p) ?? defaultConnections()[0];
  return {
    sources: {
      jira: new SimulatedAdapter('jira', world, conn('jira')),
      ga4: new SimulatedAdapter('ga4', world, conn('ga4')),
      app_store: new SimulatedAdapter('app_store', world, conn('app_store')),
      google_play: new SimulatedAdapter('google_play', world, conn('google_play')),
    },
    email: new SimulatedEmailChannel(conn('email')),
  };
}

/** Resolve a source reference to the underlying record — powers deep links and the grounding eval. */
export function resolveRef(world: World, ref: SourceRef): MetricSeries | IssueRecord | ReleaseRecord | ReviewRecord | undefined {
  switch (ref.kind) {
    case 'metric':
      return world.metrics.find((m) => m.id === ref.id && m.provider === ref.provider);
    case 'issue':
      return world.issues.find((i) => i.id === ref.id);
    case 'release':
      return world.releases.find((r) => r.id === ref.id && r.provider === ref.provider);
    case 'review':
      return world.reviews.find((r) => r.id === ref.id && r.provider === ref.provider);
  }
}
