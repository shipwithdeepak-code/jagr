import { describe, expect, it } from 'vitest';
import { connectRequest, githubConfigFromFields, githubFieldsFromConfig } from './connectionForm';

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
