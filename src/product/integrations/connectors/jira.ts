import { z } from 'zod';
import type { ChangeRecord, WorkItem } from '../../roles/types';
import type { ConnectorDescriptor, ReadStamp } from './types';
import { basicAuth, requestJson } from './http';
import { provenance } from './runtime';
import { redactPersonalData } from './redact';
import { JiraCloudAdapter } from '../jiraCloud';
import type { IssueRecord } from '../types';
import { ProviderUnavailableError } from '../types';

/**
 * Jira Cloud — WorkItemSource (issues) and ChangeSource (released project versions), built on the
 * existing Jira Cloud client (`../jiraCloud.ts`, REST v3). Read-only; basic auth with an Atlassian
 * account email + API token (the email is part of the credential and lives only in the SecretStore).
 *
 *   POST /rest/api/3/search/jql                 issues created in the window (token-paginated)
 *   GET  /rest/api/3/project/{key}/versions     released versions
 *   GET  /rest/api/3/project/{key}              credential + project check
 *
 * Timing: a Jira version's release date is bookkeeping with day precision → `planned`. It is shown as
 * evidence and never used to claim a timing association.
 * Only Jira Cloud sites (*.atlassian.net) — Jira Data Center is not supported.
 */

export const JiraConfig = z
  .object({
    site: z.string().regex(/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net\/?$/, { message: 'must be a Jira Cloud site, https://<name>.atlassian.net' }),
    project: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, { message: 'must be a Jira project key, e.g. SHOP' }),
    maxPages: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export type JiraConfig = z.infer<typeof JiraConfig>;

const TYPE: Record<IssueRecord['type'], WorkItem['type']> = { Bug: 'bug', Task: 'task', Incident: 'incident' };
const PRIORITY: Record<IssueRecord['priority'], WorkItem['priority']> = { Highest: 'critical', High: 'high', Medium: 'medium', Low: 'low' };

const hostOf = (site: string) => new URL(site).hostname;
const base = (site: string) => site.replace(/\/$/, '');

function authOf(secret: { kind: string; fields?: Record<string, string> }): string {
  if (secret.kind !== 'api_key' || !secret.fields?.email || !secret.fields.apiToken) throw new ProviderUnavailableError('jira', 'error', 'Jira credential is incomplete (account email and API token).');
  return basicAuth(secret.fields.email, secret.fields.apiToken);
}

export const jiraConnector: ConnectorDescriptor<JiraConfig> = {
  id: 'jira',
  source: 'jira',
  name: 'Jira',
  roles: ['work_items', 'changes'],
  config: JiraConfig as unknown as z.ZodType<JiraConfig>,
  secretKinds: ['api_key'],
  credentialFields: [{ key: 'email', label: 'Atlassian account email' }, { key: 'apiToken', label: 'API token' }],
  hosts: (cfg) => [hostOf(cfg.site)],
  build(ctx) {
    const client = () => new JiraCloudAdapter({ baseUrl: base(ctx.config.site), projectKey: ctx.config.project, authorization: authOf(ctx.secret), http: ctx.http, maxPages: ctx.config.maxPages });
    const stamp = (): ReadStamp => ({ connectionId: ctx.connection.id, provider: 'jira', source: 'jira', fetchedAt: ctx.clock.now() });
    return {
      work_items: {
        async getWorkItems({ window }) {
          const s = stamp();
          return (await client().getIssues(window)).map(
            (i): WorkItem => ({
              id: i.id,
              source: 'jira',
              title: redactPersonalData(i.title).slice(0, 300),
              type: TYPE[i.type] ?? 'other',
              priority: PRIORITY[i.priority] ?? 'medium',
              component: i.component || undefined,
              area: i.area,
              labels: i.labels,
              versions: i.affectsVersion ? [i.affectsVersion] : [],
              createdAt: i.createdAt,
              ref: { provider: 'jira', kind: 'issue', id: i.id },
              provenance: provenance(s, i.id, i.createdAt, `${base(ctx.config.site)}/browse/${encodeURIComponent(i.id)}`),
            }),
          );
        },
      },
      changes: {
        tracksRollout: false,
        async getChanges({ window }) {
          const s = stamp();
          return (await client().getReleases(window))
            .filter((r) => r.releasedAt >= window.start && r.releasedAt <= window.end)
            .map((r): ChangeRecord => {
              const versionId = r.id.replace(/^jira-ver-/, '');
              return {
                id: r.id,
                source: 'jira',
                kind: 'release',
                timing: 'planned',
                title: `Release ${r.version}`,
                at: r.releasedAt,
                version: r.version,
                notes: redactPersonalData(r.notes).slice(0, 500),
                ref: { provider: 'jira', kind: 'release', id: r.id },
                provenance: provenance(s, r.id, r.releasedAt, `${base(ctx.config.site)}/projects/${encodeURIComponent(ctx.config.project)}/versions/${encodeURIComponent(versionId)}`),
              };
            });
        },
      },
    };
  },
  async check(ctx) {
    const p = await requestJson<{ key?: string; name?: string }>(ctx.http, 'jira', 'Jira', `${base(ctx.config.site)}/rest/api/3/project/${encodeURIComponent(ctx.config.project)}`, { headers: { Accept: 'application/json', Authorization: authOf(ctx.secret) } });
    if (p?.key !== ctx.config.project) return { state: 'error', detail: `Jira project ${ctx.config.project} was not found with this account.` };
    return { state: 'connected', detail: `Jira Cloud · project ${ctx.config.project}`, account: `${hostOf(ctx.config.site)} · ${ctx.config.project}` };
  },
};
