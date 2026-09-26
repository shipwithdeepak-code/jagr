/**
 * The body of a connect / configure request (PUT /api/workspaces/:id/connections). Editing only the
 * configuration sends no credential at all, so the server keeps the stored one.
 */
export function connectRequest(provider: string, config: Record<string, unknown>, credential?: Record<string, string>): { provider: string; config: Record<string, unknown>; credential?: Record<string, string> } {
  return credential ? { provider, config, credential } : { provider, config };
}

/** GitHub's configuration as form fields: one repository or environment per line (commas also split). */
export interface GitHubFields {
  repos: string;
  environments: string;
  releases: boolean;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const list = (s: string) => [...new Set(s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];

export function githubFieldsFromConfig(config: Record<string, unknown> | undefined): GitHubFields {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { repos: arr(config?.repos).join('\n'), environments: (arr(config?.environments).length ? arr(config?.environments) : ['Production']).join('\n'), releases: config?.releases !== false };
}

/** The configuration to send, or what the person has to fix — checked before anything is sent. */
export function githubConfigFromFields(f: GitHubFields): { config: Record<string, unknown> } | { error: string } {
  const repos = list(f.repos);
  const environments = list(f.environments);
  if (!repos.length) return { error: 'Add at least one repository, as owner/repo.' };
  const bad = repos.filter((r) => !REPO.test(r));
  if (bad.length) return { error: `Not a repository in owner/repo form: ${bad.join(', ')}.` };
  if (repos.length > 20) return { error: 'At most 20 repositories.' };
  if (!environments.length) return { error: 'Add at least one deployment environment, e.g. Production.' };
  if (environments.length > 5) return { error: 'At most 5 environments.' };
  return { config: { repos, environments, releases: f.releases } };
}
