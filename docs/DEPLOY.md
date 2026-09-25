# Deploying the Jagr server on Vercel

The frontend and the API deploy together from this repository: Vite builds the app into `dist/`, and each
file in `api/` is a Vercel function (`api/[...route].ts` serves every `/api/*` route except the planner,
which `api/planner.ts` serves). Nothing else is needed on Vercel's side. Until the variables below are set,
`/api/*` answers 503 and the app stays browser-local ("This build has no Jagr server behind it").

Secrets go into Vercel → Project → Settings → Environment Variables (Production), never into the
repository, a `VITE_`-prefixed variable, or a chat.

## 1. Vercel project settings

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Build command | `npm run build` (default) |
| Output directory | `dist` (default) |
| Install command | default |
| Node.js version | 20.x or newer (the functions use built-in `fetch` and ESM) |
| Production branch | `main` |

`vercel.json` holds only the rewrites (planner paths; SPA fallback for everything outside `/api/`).

## 2. Database (Neon, or any Postgres 14+)

1. Create a Neon project (region close to the Vercel function region, e.g. `us-east-1` for `iad1`).
2. Copy the **pooled** connection string (host contains `-pooler`), with `sslmode=require`.
3. Set it as `DATABASE_URL` in Vercel. Leave `DATABASE_SSL` unset (TLS with certificate verification).

Migrations run automatically when a function instance starts (idempotent, recorded in `jagr_migrations`).
Tables: `workspaces`, `users`, `identities`, `memberships`, `sessions`, `audit_log`, `jobs`, `secrets`,
and `workspace_docs` — the per-workspace documents: connections, watches, investigations, decisions
(approvals), notifications, briefs, sync cursors, imports and run locks. Credentials live only in
`secrets`, envelope-encrypted with `JAGR_SECRET_KEY`.

## 3. Sign-in (at least one provider)

**Google** — Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application):
- Authorized JavaScript origin: `https://<your domain>`
- Authorized redirect URI: `https://<your domain>/api/auth/google/callback`
- Scopes requested: `openid email profile`
- Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

**GitHub** — GitHub → Settings → Developer settings → OAuth Apps → New:
- Homepage URL: `https://<your domain>`
- Authorization callback URL: `https://<your domain>/api/auth/github/callback`
- Scopes requested: `read:user user:email`
- Set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`.

`JAGR_APP_URL` must be exactly the public origin (e.g. `https://jagr.vercel.app`): redirect URIs are built
from it, and an `https://` value makes cookies `Secure`. Sessions are `HttpOnly` cookies; state-changing
calls also need the CSRF double-submit token the app sends.

## 4. Environment variables (names only)

| Group | Variable | Notes |
|---|---|---|
| A. Server | `JAGR_APP_URL` | public origin, no trailing slash |
| A. Server | `JAGR_SESSION_SECRET` | ≥ 32 random chars: `openssl rand -hex 32` |
| A. Server | `JAGR_SECRET_KEY` | 32 random bytes, base64: `openssl rand -base64 32` — encrypts stored credentials; losing it makes them unreadable |
| B. Auth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | and/or the GitHub pair |
| B. Auth | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | the OAuth App for *sign-in* (not the connector) |
| C. Database | `DATABASE_URL` | Neon pooled URL with `sslmode=require` |
| C. Database | `DATABASE_SSL` | optional: `no-verify` or `disable` only for special setups |
| D. Scheduling | `CRON_SECRET` | `openssl rand -hex 32`; the same value goes into GitHub Actions (below) |
| E. Later | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` | optional AI planner |
| E. Later | `JAGR_MODE`, `JAGR_OWNER_IDENTITIES`, `JAGR_GITHUB_*`, `JAGR_JIRA_*`, `JAGR_AMPLITUDE_*`, `JAGR_INTERCOM_*`, `JAGR_SLACK_*` | single-tenant owner credentials only; in multi-tenant mode members connect sources in the app |

After changing variables, redeploy (Vercel applies them to new deployments only).

## 5. Scheduling (watches run with the browser closed)

The scheduler is `/api/cron/tick`: with `Authorization: Bearer $CRON_SECRET` it enqueues every due watch run
and brief (idempotent per watch and slot, so repeated or overlapping ticks never double-run), then drains
up to 10 jobs under a lease (a job whose worker died is retried when its lease expires). Missed slots are
caught up: the latest due run is taken and older ones are recorded as superseded.

Vercel Hobby allows Cron Jobs at most once a day, so the tick is driven by
`.github/workflows/jagr-cron.yml` every 15 minutes. In GitHub → repository → Settings → Secrets and
variables → Actions:
- variable `JAGR_APP_URL` = the same public origin
- secret `CRON_SECRET` = the same value as in Vercel

GitHub runs scheduled workflows on a best-effort basis (delays of several minutes are normal) and pauses
them after 60 days without repository activity. On Vercel Pro, a `crons` entry in `vercel.json` (Vercel sends
the same bearer header) can replace the workflow.

## 6. Verify

```sh
curl https://<your domain>/api/health          # {"ok":true,"mode":"multi-tenant","signIn":["google",…]}
JAGR_SMOKE_URL=https://<your domain> npm run smoke:production
```

The smoke test checks health, the planner, sign-in redirects (state cookie `HttpOnly; Secure`), that every
workspace route refuses without a session, that the tick refuses without the secret, and that the client
bundle contains no secret material. Then, in the app: Settings → *Where this workspace lives* → sign in →
create a server workspace → Sources → *Connect a source* → GitHub.

## 7. First live connector: GitHub

A fine-grained personal access token, read-only, for the repositories to watch: **Metadata: read**,
**Contents: read**, **Deployments: read**. Enter it in the app (Sources → Connect a source → GitHub); it is
stored encrypted on the server and never sent back to the browser. Configuration: `repos: ["owner/repo"]`,
`environments: ["Production"]` — Vercel records its deployments in GitHub under `Production` / `Preview`.

GitHub is a *change* source (deployments, releases). Investigations start from a signal — metrics,
issues or feedback — and GitHub changes are correlated into them as evidence. A workspace with GitHub
alone monitors, but has no signal to open an investigation on.
