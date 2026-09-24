import { z } from 'zod';
import type { ChangeRecord, TimeWindow } from '../../roles/types';
import type { ConnectorContext, ConnectorDescriptor, ReadStamp } from './types';
import { requestJson } from './http';
import { provenance } from './runtime';
import { redactPersonalData } from './redact';
import { ProviderUnavailableError } from '../types';

/**
 * GitHub — ChangeSource: deployments (actual timing) and releases (reported timing). REST API,
 * read-only, with a fine-grained personal access token (Deployments: read, Contents: read, Metadata: read).
 *
 *   GET /repos/{repo}/deployments?environment=…   deployments, newest first
 *   GET /repos/{repo}/deployments/{id}/statuses   when (and whether) each deployment finished
 *   GET /repos/{repo}/releases                     published releases
 *   GET /repos/{repo}                              credential check
 *
 * Timing:
 *   - a deployment's time is its first `success` status — when the change reached the environment (`actual`);
 *     a failed deployment is recorded at its failure, status `failed`; one still running is `in_progress`
 *     at its creation time with `reported` timing
 *   - a release's time is when it was published on GitHub (`reported`): GitHub does not know when users got it
 *
 * Not built: GitHub App authentication (a token is required; an App configuration is refused as invalid
 * configuration, never silently ignored), GitHub Enterprise Server hosts.
 */

export const GitHubConfig = z
  .object({
    repos: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)).min(1).max(20),
    environments: z.array(z.string().min(1).max(100)).min(1).max(5).default(['production']),
    releases: z.boolean().default(true),
    auth: z.literal('token', { message: 'GitHub App authentication is not supported yet; set JAGR_GITHUB_TOKEN' }).default('token'),
  })
  .strict();
export type GitHubConfig = z.infer<typeof GitHubConfig>;

interface Deployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  description?: string | null;
}
interface DeploymentStatus {
  state: 'success' | 'failure' | 'error' | 'inactive' | 'in_progress' | 'queued' | 'pending';
  created_at: string;
}
interface Release {
  id: number;
  tag_name: string;
  name?: string | null;
  published_at?: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

const API = 'https://api.github.com';
const PER_PAGE = 50;
const MAX_PAGES = 3;
/** Deployments started up to this long before the window can still finish inside it. */
const LOOKBACK_MS = 6 * 3_600_000;

class GitHubReader {
  constructor(private readonly ctx: ConnectorContext<GitHubConfig>) {}

  private stamp(): ReadStamp {
    return { connectionId: this.ctx.connection.id, provider: 'github', source: 'github', fetchedAt: this.ctx.clock.now() };
  }
  private get headers() {
    const s = this.ctx.secret;
    if (s.kind !== 'api_key' || !s.fields.token) throw new ProviderUnavailableError('github', 'error', 'GitHub credential is incomplete (a token is required).');
    return { authorization: `Bearer ${s.fields.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  }
  get<T>(path: string): Promise<T> {
    return requestJson<T>(this.ctx.http, 'github', 'GitHub', `${API}${path}`, {
      headers: this.headers,
      // GitHub signals an exhausted rate limit with 403 (or 429) and no remaining quota.
      isRateLimited: (res) => res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0',
    });
  }

  async deployments(repo: string, environment: string, window: TimeWindow): Promise<ChangeRecord[]> {
    const since = Date.parse(window.start) - LOOKBACK_MS;
    const out: ChangeRecord[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await this.get<Deployment[]>(`/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(list)) throw new ProviderUnavailableError('github', 'error', 'GitHub returned deployments Jagr could not read.');
      const relevant = list.filter((d) => Date.parse(d.created_at) >= since && d.created_at <= window.end);
      for (const d of relevant) {
        const rec = await this.deployment(repo, d, window);
        if (rec) out.push(rec);
      }
      // Newest first: stop once a page reaches back before the window.
      if (list.length < PER_PAGE || list.some((d) => Date.parse(d.created_at) < since)) break;
    }
    return out;
  }

  private async deployment(repo: string, d: Deployment, window: TimeWindow): Promise<ChangeRecord | undefined> {
    const statuses = await this.get<DeploymentStatus[]>(`/repos/${repo}/deployments/${d.id}/statuses?per_page=100`);
    if (!Array.isArray(statuses)) throw new ProviderUnavailableError('github', 'error', 'GitHub returned deployment statuses Jagr could not read.');
    // "As of" the window end: statuses after it have not happened yet.
    const seen = statuses.filter((s) => s.created_at <= window.end).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const success = seen.find((s) => s.state === 'success');
    const failure = seen.find((s) => s.state === 'failure' || s.state === 'error');
    const [at, status, timing]: [string, ChangeRecord['status'], ChangeRecord['timing']] = success
      ? [success.created_at, 'success', 'actual']
      : failure
        ? [failure.created_at, 'failed', 'actual']
        : [d.created_at, 'in_progress', 'reported'];
    if (at < window.start || at > window.end) return undefined;
    const short = d.sha.slice(0, 7);
    const id = `${repo}#deployment-${d.id}`;
    return {
      id: `github-deploy-${repo}-${d.id}`,
      source: 'github',
      kind: 'deploy',
      timing,
      title: `Deploy ${short} to ${d.environment} (${repo})`,
      at: new Date(at).toISOString(),
      version: d.ref,
      status,
      notes: [d.description ? redactPersonalData(d.description).slice(0, 300) : undefined, status === 'in_progress' ? 'still in progress — start time, not completion' : undefined].filter(Boolean).join(' · ') || undefined,
      ref: { provider: 'github', kind: 'release', id },
      provenance: provenance(this.stamp(), id, new Date(at).toISOString(), `https://github.com/${repo}/commit/${d.sha}`),
    };
  }

  async releases(repo: string, window: TimeWindow): Promise<ChangeRecord[]> {
    const list = await this.get<Release[]>(`/repos/${repo}/releases?per_page=${PER_PAGE}`);
    if (!Array.isArray(list)) throw new ProviderUnavailableError('github', 'error', 'GitHub returned releases Jagr could not read.');
    const out: ChangeRecord[] = [];
    for (const r of list) {
      if (r.draft || !r.published_at) continue;
      const at = new Date(r.published_at).toISOString();
      if (at < window.start || at > window.end) continue;
      const id = `${repo}#release-${r.id}`;
      out.push({
        id: `github-release-${repo}-${r.id}`,
        source: 'github',
        kind: 'release',
        timing: 'reported',
        title: `${redactPersonalData(r.name || r.tag_name).slice(0, 200)} (${repo})`,
        at,
        version: r.tag_name,
        notes: `GitHub release published${r.prerelease ? ' (pre-release)' : ''} — when users received it is not known from GitHub`,
        ref: { provider: 'github', kind: 'release', id },
        provenance: provenance(this.stamp(), id, at, /^https:\/\/github\.com\//.test(r.html_url) ? r.html_url : `https://github.com/${repo}/releases`),
      });
    }
    return out;
  }
}

export const githubConnector: ConnectorDescriptor<GitHubConfig> = {
  id: 'github',
  source: 'github',
  name: 'GitHub',
  roles: ['changes'],
  config: GitHubConfig as unknown as z.ZodType<GitHubConfig>,
  secretKinds: ['api_key'],
  hosts: () => ['api.github.com'],
  build(ctx) {
    const r = new GitHubReader(ctx);
    return {
      changes: {
        tracksRollout: false,
        async getChanges({ window }) {
          const out: ChangeRecord[] = [];
          for (const repo of ctx.config.repos) {
            for (const env of ctx.config.environments) out.push(...(await r.deployments(repo, env, window)));
            if (ctx.config.releases) out.push(...(await r.releases(repo, window)));
          }
          return out.sort((a, b) => a.at.localeCompare(b.at));
        },
      },
    };
  },
  async check(ctx) {
    const r = new GitHubReader(ctx);
    for (const repo of ctx.config.repos) await r.get<{ full_name: string }>(`/repos/${repo}`);
    return { state: 'connected', detail: `GitHub · ${ctx.config.repos.length} repositor${ctx.config.repos.length === 1 ? 'y' : 'ies'} · ${ctx.config.environments.join(', ')}`, account: ctx.config.repos.join(', ') };
  },
};
