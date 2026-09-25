import type { ProviderId, SourceConnection, SourceLink, SourceRef } from '../types.js';
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
} from './types.js';
import { BUCKET_MIN, type World } from './world.js';
import { SourceRegistry } from '../roles/registry.js';
import type { SourceId } from '../roles/types.js';
import { isSourceId } from '../roles/types.js';
import { roleSourceFromAdapter } from './bridge.js';

/**
 * Simulated adapters for Jira, GA4, App Store Connect and Google Play.
 * They behave like real APIs: windowed queries, only data that exists "as of" the query,
 * and hard failures when the connection is unavailable or erroring. They never fabricate.
 */

export const PROVIDERS: Record<ProviderId, { name: string; short: string; capabilities: Capability[]; externalBase: string; realApi: string }> = {
  jira: { name: 'Jira', short: 'Jira', capabilities: ['issues', 'releases', 'events', 'changes'], externalBase: 'https://your-company.atlassian.net', realApi: 'Jira Cloud REST API v3' },
  ga4: { name: 'Google Analytics 4', short: 'Analytics', capabilities: ['metrics'], externalBase: 'https://analytics.google.com/analytics/web', realApi: 'GA4 Data API (runReport)' },
  app_store: { name: 'App Store Connect', short: 'App Store', capabilities: ['metrics', 'releases', 'reviews', 'events', 'changes', 'rollout'], externalBase: 'https://appstoreconnect.apple.com', realApi: 'App Store Connect API' },
  google_play: { name: 'Google Play Console', short: 'Play Store', capabilities: ['metrics', 'releases', 'reviews', 'events', 'changes', 'rollout'], externalBase: 'https://play.google.com/console', realApi: 'Play Developer Reporting API' },
  github: { name: 'GitHub', short: 'GitHub', capabilities: ['releases', 'changes'], externalBase: 'https://github.com', realApi: 'GitHub REST API (deployments, releases)' },
  amplitude: { name: 'Amplitude', short: 'Amplitude', capabilities: ['metrics', 'changes'], externalBase: 'https://app.amplitude.com', realApi: 'Amplitude Dashboard REST API' },
  intercom: { name: 'Intercom', short: 'Intercom', capabilities: ['reviews'], externalBase: 'https://app.intercom.com', realApi: 'Intercom REST API (conversations)' },
  slack: { name: 'Slack', short: 'Slack', capabilities: ['send_email'], externalBase: 'https://slack.com', realApi: 'Slack Web API (chat.postMessage)' },
  email: { name: 'Email', short: 'Email', capabilities: ['send_email'], externalBase: 'mailto:', realApi: 'SMTP / transactional email provider' },
};

/** Display name for a source channel. Imported data renames the channel (e.g. "Feedback", not "App Store"). */
export type ProviderLabel = { name: string; short: string };
export type ProviderLabels = Partial<Record<ProviderId, ProviderLabel>>;
export const labelOf =
  (labels?: ProviderLabels) =>
  (p: ProviderId): ProviderLabel =>
    labels?.[p] ?? PROVIDERS[p];
export const labelsFrom = (connections: SourceConnection[]): ProviderLabels =>
  Object.fromEntries(connections.filter((c) => c.label).map((c) => [c.provider, c.label!]));

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

/**
 * A link to a source record. `recordUrl` is the record's own page in its source (provenance.url); it is
 * used only for real (non-simulated) sources and only when it is https — otherwise the source's page.
 */
export function makeLink(ref: SourceRef, label: string, simulated: boolean, recordUrl?: string): SourceLink {
  const own = !simulated && recordUrl && /^https:\/\//.test(recordUrl) ? recordUrl : undefined;
  return { label, provider: ref.provider, href: sourceHref(ref), externalUrl: own ?? externalUrl(ref), simulated, ref };
}

const inWindow = (at: string, w: TimeWindow) => at >= w.start && at <= w.end;

class SimulatedAdapter implements IntegrationAdapter {
  readonly name: string;
  readonly capabilities: Capability[];
  constructor(
    readonly provider: SourceId,
    private readonly world: World,
    private readonly conn: SourceConnection,
  ) {
    this.name = PROVIDERS[provider].name;
    this.capabilities = world.capabilities?.[provider] ?? PROVIDERS[provider].capabilities;
  }

  connection() {
    return this.conn;
  }

  private guard() {
    if (this.conn.state === 'not_configured') throw new ProviderUnavailableError(this.provider, 'unavailable', 'not configured');
    if (this.conn.state === 'needs_reconnect') throw new ProviderUnavailableError(this.provider, 'unavailable', 'needs to be reconnected');
    if (this.conn.state === 'unavailable' || this.conn.state === 'error') {
      throw new ProviderUnavailableError(this.provider, this.conn.state, this.conn.detail);
    }
  }

  /** A stale source only has data up to its last sync: nothing after `freshAsOf` is visible. */
  private visible(window: TimeWindow): TimeWindow {
    const f = this.conn.freshAsOf;
    return f && f < window.end ? { start: window.start, end: f } : window;
  }

  listMetrics() {
    if (!this.capabilities.includes('metrics')) return [];
    // A world may declare metrics it has no data for (imports: every metric the user could upload).
    const defs = this.world.metricCatalog ?? this.world.metrics;
    return defs.filter((m) => m.provider === this.provider).map((m) => ({ id: m.id, provider: m.provider, name: m.name, unit: m.unit, area: m.area, badDirection: m.badDirection, mode: m.mode, threshold: m.threshold, platform: m.platform }));
  }

  async getMetrics(ids: string[], requested: TimeWindow): Promise<MetricSeries[]> {
    this.guard();
    const window = this.visible(requested);
    if (!this.capabilities.includes('metrics')) return [];
    return this.world.metrics
      .filter((m) => m.provider === this.provider && ids.includes(m.id))
      .map((m) => ({
        ...m,
        // Only buckets that have completed by the end of the window.
        points: m.points.filter((p) => p.t >= window.start && Date.parse(p.t) + (this.world.bucketMinutes ?? BUCKET_MIN) * 60_000 <= Date.parse(window.end)),
      }));
  }

  async getIssues(requested: TimeWindow): Promise<IssueRecord[]> {
    this.guard();
    const window = this.visible(requested);
    if (this.provider !== 'jira') return [];
    return this.world.issues.filter((i) => inWindow(i.createdAt, window));
  }

  async getReleases(requested: TimeWindow): Promise<ReleaseRecord[]> {
    this.guard();
    const window = this.visible(requested);
    return this.world.releases.filter((r) => r.provider === this.provider && inWindow(r.releasedAt, window));
  }

  async getReviews(requested: TimeWindow): Promise<ReviewRecord[]> {
    this.guard();
    const window = this.visible(requested);
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
      ...reviews.map((r): SourceEvent => ({ at: r.createdAt, provider: this.provider, kind: 'review', title: `${r.rating ? `${r.rating}★ ` : ''}${r.title}`, ref: { provider: this.provider, kind: 'review', id: r.id } })),
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
  sources: Partial<Record<SourceId, IntegrationAdapter>>;
  email: SimulatedEmailChannel;
}

/** The workspace's sources as a role registry. Order = PROVIDERS order, which the engine consults in. */
export function createRegistry(world: World, connections: SourceConnection[]): { registry: SourceRegistry; email: SimulatedEmailChannel } {
  const reg = createAdapters(world, connections);
  // Only sources the workspace has a connection for (in any state) are part of it.
  const ids = (Object.keys(PROVIDERS) as ProviderId[]).filter((p): p is SourceId => isSourceId(p) && connections.some((c) => c.provider === p));
  return { registry: new SourceRegistry(ids.map((id) => roleSourceFromAdapter(reg.sources[id] as IntegrationAdapter & { provider: SourceId }))), email: reg.email };
}

export function defaultConnections(at = '2026-09-23T17:55:00.000Z'): SourceConnection[] {
  // The Sample workspace's channels. Connector sources (GitHub, Amplitude, Intercom) and Slack are not part of the sample night.
  return (['jira', 'ga4', 'app_store', 'google_play', 'email'] as ProviderId[]).map((provider) => ({
    provider,
    state: 'simulated',
    detail: provider === 'email' ? 'Simulated outbox — emails are rendered in Jagr, never delivered' : 'Deterministic fixture data (no credentials configured)',
    updatedAt: at,
  }));
}

export function createAdapters(world: World, connections: SourceConnection[]): AdapterRegistry {
  // A source without a connection is simply not configured — never borrow another source's state.
  const conn = (p: ProviderId): SourceConnection => connections.find((c) => c.provider === p) ?? { provider: p, state: 'not_configured', detail: 'Not connected to this workspace.', updatedAt: world.start };
  return {
    sources: {
      jira: new SimulatedAdapter('jira', world, conn('jira')),
      ga4: new SimulatedAdapter('ga4', world, conn('ga4')),
      app_store: new SimulatedAdapter('app_store', world, conn('app_store')),
      google_play: new SimulatedAdapter('google_play', world, conn('google_play')),
      github: new SimulatedAdapter('github', world, conn('github')),
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
