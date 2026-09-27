import { describe, expect, it } from 'vitest';
import { connectRequest, connectionConfigFromFields, connectionFieldsFromConfig, githubConfigFromFields, githubFieldsFromConfig } from './connectionForm';

describe('connect / configure request body', () => {
  it('editing only the configuration sends no credential (the server keeps the stored one)', () => {
    const body = connectRequest('github', { repos: ['acme/web'], environments: ['Production'] });
    expect(body).toEqual({ provider: 'github', config: { repos: ['acme/web'], environments: ['Production'] } });
    expect('credential' in body).toBe(false);
  });

  it('connecting sends the credential with the configuration', () => {
    expect(connectRequest('github', { repos: ['acme/web'] }, { token: 't' })).toEqual({ provider: 'github', config: { repos: ['acme/web'] }, credential: { token: 't' } });
  });
});

describe('provider-specific connection fields', () => {
  it('builds Sentry configuration from readable workspace fields while preserving signal mappings', () => {
    const base = { metrics: [{ kind: 'errors', key: 'checkout_errors' }] };
    const fields = { region: 'de', organization: 'acme', projects: '123, 456', environment: 'production', releases: true, issues: true };
    expect(connectionConfigFromFields('sentry', fields, base)).toEqual({ config: { ...base, region: 'de', organization: 'acme', projects: [123, 456], environment: 'production', releases: true, issues: true } });
    expect(connectionConfigFromFields('sentry', { ...fields, projects: 'project-one' }, base)).toMatchObject({ error: expect.stringMatching(/numeric Sentry project IDs/) });
  });

  it('validates each connector’s actual manual identifiers before sending', () => {
    expect(connectionConfigFromFields('jira', { site: 'http://jira.local', project: 'shop' }, {})).toMatchObject({ error: expect.stringMatching(/Jira Cloud URL/) });
    expect(connectionConfigFromFields('intercom', { region: 'eu', appId: 'workspace1' }, { maxPages: 4 })).toEqual({ config: { region: 'eu', appId: 'workspace1', maxPages: 4 } });
    expect(connectionConfigFromFields('slack', { channel: 'general' }, {})).toMatchObject({ error: expect.stringMatching(/channel ID/) });
  });

  it('preserves Amplitude signal definitions while updating understandable workspace settings', () => {
    const base = { metrics: [{ kind: 'count', key: 'signups' }], dimensions: { platform: 'platform' } };
    expect(connectionConfigFromFields('amplitude', { region: 'eu', appUrl: 'https://analytics.eu.amplitude.com/acme', utcOffsetMinutes: '60', annotations: false }, base)).toEqual({
      config: { ...base, region: 'eu', appUrl: 'https://analytics.eu.amplitude.com/acme', utcOffsetMinutes: 60, annotations: false },
    });
  });

  it('round-trips every normal field without exposing credentials as configuration', () => {
    expect(connectionFieldsFromConfig('jira', { site: 'https://acme.atlassian.net', project: 'SHOP', maxPages: 3 })).toEqual({ site: 'https://acme.atlassian.net', project: 'SHOP' });
    expect(connectionFieldsFromConfig('slack', { channel: 'C0123456789' })).toEqual({ channel: 'C0123456789' });
    expect(JSON.stringify(connectionFieldsFromConfig('sentry', { region: 'us', organization: 'acme', projects: [1], metrics: [] }))).not.toMatch(/token|secret|credential/i);
  });
});

describe('GitHub configuration fields', () => {
  it('round-trips a stored configuration through the form', () => {
    const f = githubFieldsFromConfig({ repos: ['acme/web', 'acme/api'], environments: ['Production'], releases: false, auth: 'token' });
    expect(f).toEqual({ repos: 'acme/web\nacme/api', environments: 'Production', releases: false });
    expect(githubConfigFromFields(f)).toEqual({ config: { repos: ['acme/web', 'acme/api'], environments: ['Production'], releases: false } });
  });

  it('a new connection starts with Production and releases on', () => {
    expect(githubFieldsFromConfig(undefined)).toEqual({ repos: '', environments: 'Production', releases: true });
  });

  it('names what to fix instead of sending an invalid configuration', () => {
    expect(githubConfigFromFields({ repos: '', environments: 'Production', releases: true })).toEqual({ error: 'Add at least one repository, as owner/repo.' });
    expect(githubConfigFromFields({ repos: 'acme', environments: 'Production', releases: true })).toEqual({ error: 'Not a repository in owner/repo form: acme.' });
    expect(githubConfigFromFields({ repos: 'acme/web', environments: ' ', releases: true })).toMatchObject({ error: expect.stringMatching(/environment/) });
    // Commas and blank lines are tolerated; duplicates collapse.
    expect(githubConfigFromFields({ repos: 'acme/web, acme/web\n\nacme/api', environments: 'Production,Preview', releases: true })).toEqual({ config: { repos: ['acme/web', 'acme/api'], environments: ['Production', 'Preview'], releases: true } });
  });
});
