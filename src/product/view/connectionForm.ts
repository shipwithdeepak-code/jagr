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

export type ConnectionFields = Record<string, string | boolean>;

const numbers = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []);

/** Non-secret connector configuration translated into human-readable form fields. */
export function connectionFieldsFromConfig(provider: string, config: Record<string, unknown>): ConnectionFields {
  if (provider === 'github') {
    const fields = githubFieldsFromConfig(config);
    return { repos: fields.repos, environments: fields.environments, releases: fields.releases };
  }
  if (provider === 'jira') return { site: String(config.site ?? ''), project: String(config.project ?? '') };
  if (provider === 'intercom') return { region: String(config.region ?? 'us'), appId: String(config.appId ?? '') };
  if (provider === 'slack') return { channel: String(config.channel ?? '') };
  if (provider === 'sentry')
    return {
      region: String(config.region ?? 'us'),
      organization: String(config.organization ?? ''),
      projects: numbers(config.projects).join(', '),
      environment: String(config.environment ?? ''),
      releases: config.releases !== false,
      issues: config.issues !== false,
    };
  if (provider === 'amplitude')
    return {
      region: String(config.region ?? 'us'),
      appUrl: String(config.appUrl ?? 'https://app.amplitude.com'),
      utcOffsetMinutes: String(config.utcOffsetMinutes ?? 0),
      annotations: config.annotations !== false,
    };
  return {};
}

const integer = (value: string, label: string, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : `${label} must be a whole number from ${min} to ${max}.`;
};

/** Build the existing connector config contract without exposing its raw JSON in the normal flow. */
export function connectionConfigFromFields(provider: string, fields: ConnectionFields, base: Record<string, unknown>): { config: Record<string, unknown> } | { error: string } {
  const text = (key: string) => String(fields[key] ?? '').trim();
  const checked = (key: string) => fields[key] === true;
  if (provider === 'github') return githubConfigFromFields({ repos: text('repos'), environments: text('environments'), releases: checked('releases') });
  if (provider === 'jira') {
    if (!/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net\/?$/.test(text('site'))) return { error: 'Enter a Jira Cloud URL such as https://your-site.atlassian.net.' };
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(text('project'))) return { error: 'Enter a Jira project key such as SHOP.' };
    return { config: { ...base, site: text('site'), project: text('project') } };
  }
  if (provider === 'intercom') {
    const region = text('region');
    if (!['us', 'eu', 'au'].includes(region)) return { error: 'Choose an Intercom data region.' };
    const appId = text('appId');
    if (appId && !/^[a-z0-9]{4,20}$/.test(appId)) return { error: 'The Intercom workspace ID must be 4–20 lowercase letters or numbers.' };
    const { appId: _appId, ...rest } = base;
    void _appId;
    return { config: { ...rest, region, ...(appId ? { appId } : {}) } };
  }
  if (provider === 'slack') {
    if (!/^[CGD][A-Z0-9]{6,20}$/.test(text('channel'))) return { error: 'Enter a Slack channel ID such as C0123456789.' };
    return { config: { channel: text('channel') } };
  }
  if (provider === 'sentry') {
    const region = text('region');
    if (!['us', 'de'].includes(region)) return { error: 'Choose a Sentry region.' };
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(text('organization'))) return { error: 'Enter the organization slug from your Sentry workspace URL.' };
    const projects = [...new Set(text('projects').split(/[\s,]+/).filter(Boolean).map(Number))];
    if (!projects.length || projects.some((id) => !Number.isInteger(id) || id <= 0) || projects.length > 10) return { error: 'Enter 1–10 numeric Sentry project IDs, separated by commas.' };
    if (text('environment') && !/^[\w.-]{1,64}$/.test(text('environment'))) return { error: 'Environment may contain letters, numbers, dots, underscores, and hyphens.' };
    const { environment: _environment, ...rest } = base;
    void _environment;
    return { config: { ...rest, region, organization: text('organization'), projects, ...(text('environment') ? { environment: text('environment') } : {}), releases: checked('releases'), issues: checked('issues') } };
  }
  if (provider === 'amplitude') {
    const region = text('region');
    if (!['us', 'eu'].includes(region)) return { error: 'Choose an Amplitude data region.' };
    if (!/^https:\/\/(app|analytics\.eu)\.amplitude\.com(?:\/[\w./-]*)?$/.test(text('appUrl'))) return { error: 'Enter an Amplitude workspace URL from app.amplitude.com or analytics.eu.amplitude.com.' };
    const utcOffsetMinutes = integer(text('utcOffsetMinutes'), 'UTC offset', -720, 840);
    if (typeof utcOffsetMinutes === 'string') return { error: utcOffsetMinutes };
    return { config: { ...base, region, appUrl: text('appUrl'), utcOffsetMinutes, annotations: checked('annotations') } };
  }
  return { error: 'This connection does not have a supported setup form.' };
}
