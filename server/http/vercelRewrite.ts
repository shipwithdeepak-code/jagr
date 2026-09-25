/**
 * Vercel routing for the Jagr API function (api/[...route].ts).
 *
 * Outside Next.js, Vercel does not support catch-all (`[...x]`) function filenames: it compiles
 * `api/[...route].ts` to a ONE-segment dynamic route (`^/api/([^/]+)$`) and answers every deeper
 * `/api/*` path with its own NOT_FOUND. So `/api/health` reached the function but
 * `/api/auth/google/start` and `/api/workspaces/:id/...` never did.
 *
 * vercel.json therefore rewrites every multi-segment `/api/*` path (except /api/planner, which has
 * its own function) to the one-segment sentinel below, carrying the original path in a query
 * parameter. The request's own query string is kept by Vercel (OAuth `code`, `state`, `returnTo`).
 */
export const REWRITE_SENTINEL = '/api/_route';
export const REWRITE_PATH_PARAM = 'jagrPath';

/**
 * The URL the application should route: the original path, with the rewrite's helper parameter
 * removed. Vercel normally passes the function the original URL; the sentinel form is handled too, so
 * routing never depends on which one arrives.
 */
export function restoreApiUrl(rawUrl: string): string {
  const url = new URL(rawUrl, 'http://localhost');
  const original = url.searchParams.get(REWRITE_PATH_PARAM);
  url.searchParams.delete(REWRITE_PATH_PARAM);
  if (url.pathname === REWRITE_SENTINEL && original) url.pathname = `/api/${original.replace(/^\/+/, '')}`;
  return `${url.pathname}${url.search}`;
}
