import type { Reply } from '../../../testkit/connectorContract';

/** Recorded Sentry REST API responses (documented shapes), shared by the connector and end-to-end tests. */

export const NOW = '2026-09-25T06:00:00.000Z';
const HOUR = 3_600_000;
export const HOURS = Array.from({ length: 8 * 24 + 1 }, (_, i) => Date.parse(NOW) - 8 * 24 * HOUR + i * HOUR);
const SPIKE = Date.parse('2026-09-25T02:00:00Z');


export function sentryRoute(u: URL): Reply | undefined {
  if (u.hostname !== 'sentry.io') return undefined;
  const p = u.pathname;
  if (p === '/api/0/organizations/acme/events-stats/') return { body: { data: HOURS.map((h) => [h / 1000, [{ count: h >= SPIKE ? 40 : 5 }]]) } };
  if (p === '/api/0/organizations/acme/sessions/')
    return { body: { intervals: HOURS.map((h) => new Date(h).toISOString()), groups: [{ by: {}, series: { 'crash_free_rate(session)': HOURS.map((h, i) => (i === 3 ? null : h >= SPIKE ? 0.97 : 0.995)) } }] } };
  if (p === '/api/0/organizations/acme/releases/')
    return {
      body: [
        { version: '4.8.1', dateCreated: '2026-09-25T00:30:00Z', dateReleased: null, lastDeploy: { dateFinished: '2026-09-25T01:00:00Z', environment: 'production' } },
        { version: '4.8.0', dateCreated: '2026-09-24T19:00:00Z', dateReleased: '2026-09-24T20:00:00Z', lastDeploy: null },
        { version: '4.9.0-beta', dateCreated: '2026-09-25T07:00:00Z', lastDeploy: null },
      ],
    };
  if (p === '/api/0/organizations/acme/issues/')
    return {
      body: [
        { id: '101', shortId: 'WEB-1A', title: 'TypeError: card.token is undefined for maria.lopez@example.org', level: 'error', count: '1204', userCount: 318, firstSeen: '2026-09-25T02:05:00Z', lastSeen: '2026-09-25T05:40:00Z', permalink: 'https://acme.sentry.io/issues/101/' },
        { id: '99', shortId: 'WEB-19', title: 'Old warning', level: 'warning', count: '3', userCount: 1, firstSeen: '2026-09-20T02:05:00Z', lastSeen: '2026-09-25T05:00:00Z', permalink: 'https://acme.sentry.io/issues/99/' },
        { id: '102', shortId: 'WEB-1B', title: 'Later issue', level: 'fatal', count: '1', userCount: 1, firstSeen: '2026-09-25T07:30:00Z', lastSeen: '2026-09-25T07:30:00Z', permalink: 'https://acme.sentry.io/issues/102/' },
      ],
    };
  if (p === '/api/0/organizations/acme/projects/') return { body: [{ id: '42', slug: 'web' }] };
  return undefined;
}

