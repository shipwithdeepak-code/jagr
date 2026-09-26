import { useEffect, useState } from 'react';
import { LogOut, Monitor, Server } from 'lucide-react';
import type { ConnectionTypeInfo } from '@/product/app/connections';
import type { ConnectionView } from '@/product/connections/model';
import { connectRequest, githubConfigFromFields, githubFieldsFromConfig, type GitHubFields } from '@/product/view/connectionForm';
import { sourceViews, type SourceActionId, type SourceView } from '@/product/view/sources';
import { isSourceId, type SourceId } from '@/product/roles/types';
import { useProduct } from '@/state/productContext';
import { markSigningIn, useServerSession } from '@/state/serverSession';
import { serverApi, ServerError } from '@/state/serverApi';
import { Badge, Button, Card, Modal, SectionTitle, Toggle, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { SourceGroups, SourcesOverview } from '@/components/sources';
import { useSignOut } from '@/components/signOut';

/**
 * Server workspaces in the browser: where the workspace lives, sign-in, and connecting live sources.
 * The same pages render server and browser workspaces; these components only add what a server
 * workspace has and a browser workspace does not.
 */

const inputCls = 'mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-[14px] text-ink';

/** Where the open workspace lives, and — for this browser's workspace — how to get to a server one. */
export function workspacePanelNote({ onServer, hasServer, signedIn }: { onServer: boolean; hasServer: boolean; signedIn: boolean }): string {
  if (onServer) return 'Stored on this Jagr server. Watches run on their schedule without this browser open.';
  if (!hasServer) return 'Stored in this browser only. Server workspaces — live connections, scheduled monitoring, shared approvals — are available where a Jagr server is deployed.';
  // Signed in but in this browser's workspace: they need to open a server workspace, not sign in.
  if (signedIn) return 'Stored in this browser only. Open a server workspace, with live sources and scheduled monitoring, from the workspace menu at the top of the sidebar.';
  return 'Stored in this browser only. Sign in to use server workspaces with live sources and scheduled monitoring.';
}

/**
 * Settings → Workspace: what the open workspace is — its name, where it lives, and your role.
 * Switching and creating live in the workspace menu at the top of the sidebar, not here.
 */
export function WorkspacePanel() {
  const product = useProduct();
  const session = useServerSession();
  const server = product.location === 'server' ? product.server : undefined;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {server ? (
          <Badge tone="accent">
            <Server size={12} aria-hidden /> Server workspace
          </Badge>
        ) : (
          <Badge>
            <Monitor size={12} aria-hidden /> Browser workspace
          </Badge>
        )}
        <span className="font-medium text-ink">{server ? server.name : 'Local workspace'}</span>
        {server && <span className="text-ink-3">· {server.role}</span>}
      </div>
      <p className="mt-2 text-[13px] text-ink-2">{workspacePanelNote({ onServer: !!server, hasServer: !!session.server, signedIn: !!session.user })}</p>
      <p className="mt-2 text-[13px] text-ink-3">To switch or create a workspace, use the workspace menu at the top of the sidebar.</p>
    </Card>
  );
}

/** Settings → AI: the server workspace's policy on sending evidence to an AI provider. */
export function AiEgressSetting() {
  const product = useProduct();
  if (product.location !== 'server' || !product.server) return null;
  const { server } = product;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <div>
          <div className="font-medium">Allow AI planning</div>
          <p className="text-[13px] text-ink-3">When off, this workspace never sends evidence to an AI provider; the deterministic planner runs instead.</p>
        </div>
        <Toggle label="Allow AI planning" checked={server.settings.aiEgressAllowed} disabled={server.role === 'member'} onChange={(v) => void server.setAiEgressAllowed(v)} />
      </div>
    </Card>
  );
}

/** Settings → Account: who is signed in, and the same Sign out as the account menu. */
export function AccountPanel() {
  const session = useServerSession();
  const signOut = useSignOut();
  if (session.server === undefined) return null;
  if (session.server === null)
    return (
      <Card>
        <p className="text-[13px] text-ink-2">This copy of Jagr runs in the browser only, so there is no account to sign in to.</p>
      </Card>
    );
  return (
    <Card>
      {session.user ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <span>
            Signed in as <span className="font-medium text-ink">{session.user.displayName}</span>
          </span>
          <Button size="sm" variant="secondary" icon={LogOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-ink-2">{session.server.mode === 'single-tenant' ? 'Only this deployment’s configured owners can sign in.' : 'Sign in to use workspaces stored on this Jagr server.'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {session.server.signIn.length ? (
              session.server.signIn.map((p) => (
                <a key={p} className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-subtle" href={serverApi.signInUrl(p, '/settings')} onClick={markSigningIn}>
                  Sign in with {p === 'google' ? 'Google' : p === 'github' ? 'GitHub' : p}
                </a>
              ))
            ) : (
              <p className="text-[13px] text-ink-3">No sign-in provider is configured on this server.</p>
            )}
          </div>
        </>
      )}
      {session.error && <p className="mt-2 text-[13px] text-crit">{session.error}</p>}
    </Card>
  );
}

/** A server call's error, readable. */
const why = (e: unknown) => (e instanceof ServerError ? e.message : 'The server could not be reached.');

/** Sources page for a server workspace with live connections. */
export function ServerSources() {
  const product = useProduct();
  const toast = useToast();
  const srv = product.server!;
  const manage = srv.role === 'owner' || srv.role === 'admin';
  const [types, setTypes] = useState<ConnectionTypeInfo[]>([]);
  const [form, setForm] = useState<{ type: ConnectionTypeInfo; view?: ConnectionView; mode: FormMode } | undefined>();
  useEffect(() => {
    void serverApi.connectionTypes().then(setTypes, () => setTypes([]));
  }, []);

  const byId = Object.fromEntries(srv.connections.filter((c) => isSourceId(c.source as SourceId)).map((c) => [c.source, c])) as Partial<Record<SourceId, ConnectionView>>;
  const views = sourceViews(product.state.connections, { asOf: new Date().toISOString(), server: byId, canManage: manage });
  const channels = srv.connections.filter((c) => c.kind === 'channel');
  const present = new Set(srv.connections.map((c) => c.provider));
  const addable = types.filter((t) => !present.has(t.provider));

  const act = async (view: ConnectionView | undefined, action: SourceActionId, type?: ConnectionTypeInfo) => {
    const t = type ?? types.find((x) => x.provider === view?.provider);
    if (action === 'connect' || action === 'reconnect' || action === 'configure') {
      if (t) setForm({ type: t, view, mode: action });
      return;
    }
    if (!view) return;
    try {
      if (action === 'test') {
        const r = await serverApi.testConnection(srv.workspaceId, view.id);
        toast({ tone: r.check.state === 'connected' && !r.check.warnings?.length ? 'success' : 'warning', title: `${view.displayName}: ${r.connection.health.replace('_', ' ')}`, body: r.check.detail });
      } else if (action === 'disconnect') {
        if (!window.confirm(`Disconnect ${view.displayName}? The stored credential is deleted; investigations will record it as not configured.`)) return;
        await serverApi.disconnect(srv.workspaceId, view.id);
        toast({ tone: 'success', title: `${view.displayName} disconnected`, body: 'The stored credential was deleted.' });
      }
    } catch (e) {
      toast({ tone: 'warning', title: 'The server refused', body: why(e) });
    }
    await srv.refresh();
  };

  return (
    <>
      {views.length > 0 && (
        <div className="mb-8 space-y-6">
          <SourcesOverview views={views as SourceView[]} />
          <SourceGroups views={views} onAction={(v, a) => void act(byId[v.id], a)} />
        </div>
      )}
      {views.length === 0 && <p className="mb-6 text-[14px] text-ink-2">No sources are connected to this workspace yet. Connect one below — Jagr investigates only what its sources can show.</p>}

      {channels.length > 0 && (
        <section className="mb-8">
          <SectionTitle hint="Outbound only: Jagr sends alerts and briefs there. Nothing is read from, or approved in, a channel.">Notification channels</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2">
            {channels.map((c) => (
              <Card key={c.id}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{c.displayName}</div>
                  <Badge tone={c.health === 'healthy' ? 'ok' : c.health === 'unverified' ? 'neutral' : 'high'}>{c.health.replace('_', ' ')}</Badge>
                </div>
                <p className="mt-1 text-[13px] text-ink-3">{c.account ? `${c.account} · ` : ''}{c.healthDetail}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void act(c, 'test')}>Test</Button>
                  <Button size="sm" variant="secondary" disabled={!manage || c.managedBy !== 'workspace'} onClick={() => void act(c, 'reconnect')}>Reconnect</Button>
                  <Button size="sm" variant="secondary" disabled={!manage || c.managedBy !== 'workspace'} onClick={() => void act(c, 'disconnect')}>Disconnect</Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {addable.length > 0 && (
        <section>
          <SectionTitle hint={manage ? 'API keys and tokens are stored encrypted on the server and never shown again. Provider sign-in (OAuth) isn’t built.' : 'Only workspace owners and admins can connect sources.'}>Connect a source</SectionTitle>
          <div className="grid gap-3 md:grid-cols-3">
            {addable.map((t) => (
              <Card key={t.provider}>
                <div className="font-medium">{t.name}</div>
                <p className="mt-1 text-[13px] text-ink-3">{t.kind === 'channel' ? 'Outbound alerts and briefs' : `Provides ${t.roles.join(', ').replace('_', ' ')}`}</p>
                <Button className="mt-3" size="sm" disabled={!manage} onClick={() => void act(undefined, 'connect', t)}>
                  Connect
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}
      {form && <ConnectForm workspaceId={srv.workspaceId} {...form} onDone={async () => { setForm(undefined); await srv.refresh(); }} />}
    </>
  );
}

/** connect: configuration and credential · reconnect: a new credential only · configure: configuration only (the stored credential is kept). */
type FormMode = 'connect' | 'reconnect' | 'configure';

function ConnectForm({ workspaceId, type, view, mode, onDone }: { workspaceId: string; type: ConnectionTypeInfo; view?: ConnectionView; mode: FormMode; onDone: () => void }) {
  const reconnect = mode === 'reconnect';
  const configure = mode === 'configure' && !!view;
  const toast = useToast();
  const [config, setConfig] = useState(() => JSON.stringify(view?.config && Object.keys(view.config).length ? view.config : type.configExample, null, 2));
  // Known connectors get real fields; others keep the JSON configuration.
  const structured = type.provider === 'github';
  const [gh, setGh] = useState<GitHubFields>(() => githubFieldsFromConfig(view?.config && Object.keys(view.config).length ? view.config : undefined));
  const [cred, setCred] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(undefined);
    let parsed: Record<string, unknown> = {};
    if (!reconnect && structured) {
      const r = githubConfigFromFields(gh);
      if ('error' in r) {
        setError(r.error);
        return;
      }
      parsed = r.config;
    } else if (!reconnect) {
      try {
        parsed = JSON.parse(config);
      } catch {
        setError('The configuration is not valid JSON.');
        return;
      }
    }
    setBusy(true);
    try {
      const r = reconnect && view ? await serverApi.reconnect(workspaceId, view.id, cred) : await serverApi.connect(workspaceId, connectRequest(type.provider, parsed, configure ? undefined : cred));
      toast({ tone: r.check.state === 'connected' && !r.check.warnings?.length ? 'success' : 'warning', title: `${type.name}: ${r.connection.health.replace('_', ' ')}`, body: r.check.detail });
      setCred({});
      onDone();
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onDone}
      title={`${reconnect ? 'Reconnect' : configure ? 'Edit configuration:' : 'Connect'} ${type.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onDone}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || (!configure && type.credentialFields.some((f) => !cred[f.key]?.trim()))}>
            {busy ? 'Testing…' : reconnect || configure ? 'Save and test' : 'Connect and test'}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-ink-3">
        {configure
          ? 'Only the configuration changes: the stored credential is kept (it is never shown or sent to this browser). The connection is tested as soon as it is saved.'
          : 'The credential is sent once to the Jagr server, stored encrypted, and tested at once. It is never shown again or sent to this browser.'}
      </p>
      {!reconnect && structured && (
        <div className="mt-3 space-y-3">
          <label className="block text-[13px] text-ink-2" htmlFor="gh-repos">
            Repositories
            <textarea id="gh-repos" aria-describedby="gh-repos-help" className={cx(inputCls, 'h-20 py-1.5 font-mono text-[13px]')} value={gh.repos} placeholder="owner/repo" onChange={(e) => setGh({ ...gh, repos: e.target.value })} spellCheck={false} />
            <span id="gh-repos-help" className="mt-1 block text-[12px] text-ink-3">One per line, as owner/repo.</span>
          </label>
          <label className="block text-[13px] text-ink-2" htmlFor="gh-envs">
            Deployment environments
            <textarea id="gh-envs" aria-describedby="gh-envs-help" className={cx(inputCls, 'h-16 py-1.5 font-mono text-[13px]')} value={gh.environments} onChange={(e) => setGh({ ...gh, environments: e.target.value })} spellCheck={false} />
            <span id="gh-envs-help" className="mt-1 block text-[12px] text-ink-3">Exactly as your deployer names them in GitHub (Vercel uses Production and Preview). The test reports how many deployments each one returns.</span>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" className="size-4 accent-[var(--ink)]" checked={gh.releases} onChange={(e) => setGh({ ...gh, releases: e.target.checked })} />
            Include published releases as context
          </label>
        </div>
      )}
      {!reconnect && !structured && (
        <label className="mt-3 block text-[13px] text-ink-2">
          Configuration (JSON, non-secret)
          <textarea className={cx(inputCls, 'h-36 py-1.5 font-mono text-[12px]')} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} />
        </label>
      )}
      {!configure && type.credentialFields.map((f) => (
        <label key={f.key} className="mt-3 block text-[13px] text-ink-2">
          {f.label}
          <input className={inputCls} type="password" autoComplete="off" value={cred[f.key] ?? ''} onChange={(e) => setCred((c) => ({ ...c, [f.key]: e.target.value }))} />
        </label>
      ))}
      {error && <p role="alert" className="mt-3 text-[13px] text-crit">{error}</p>}
    </Modal>
  );
}
