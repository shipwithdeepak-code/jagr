import { useEffect, useState } from 'react';
import { CheckCircle2, LogOut, Mail, Monitor, Server } from 'lucide-react';
import type { ConnectionTypeInfo } from '@/product/app/connections';
import type { ConnectionView } from '@/product/connections/model';
import { connectRequest, connectionConfigFromFields, connectionFieldsFromConfig, type ConnectionFields } from '@/product/view/connectionForm';
import { sourceViews, type SourceActionId, type SourceView } from '@/product/view/sources';
import { isSourceId, type SourceId } from '@/product/roles/types';
import { useProduct } from '@/state/productContext';
import { markSigningIn, useServerSession } from '@/state/serverSession';
import { serverApi, ServerError } from '@/state/serverApi';
import { Badge, Button, Card, Modal, SectionTitle, Toggle, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { SourceGroups, SourcesOverview } from '@/components/sources';
import { useSignOut } from '@/components/signOut';
import { ProviderLogo } from '@/components/product';

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
export function ServerSources({ onConnectionSaved }: { onConnectionSaved?: (connection: ConnectionView) => void } = {}) {
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
  const addableSources = types.filter((t) => t.kind === 'source' && !present.has(t.provider));
  const slackType = types.find((t) => t.provider === 'slack');

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
      <SectionTitle hint="What Jagr investigates. Findings are limited to the evidence these connected sources can provide.">Evidence sources</SectionTitle>
      {views.length > 0 && (
        <div className="mb-8 space-y-6">
          <SourcesOverview views={views as SourceView[]} />
          <SourceGroups views={views} onAction={(v, a) => void act(byId[v.id], a)} />
        </div>
      )}
      {views.length === 0 && <p className="mb-6 text-[14px] text-ink-2">No sources are connected to this workspace yet. Connect one below — Jagr investigates only what its sources can show.</p>}

      {addableSources.length > 0 && (
        <section className="mb-8" aria-labelledby="evidence-sources">
          <SectionTitle id="evidence-sources" hint={manage ? 'Jagr investigates only what connected evidence sources can show. Credentials are stored encrypted and never shown again.' : 'Only workspace owners and admins can connect evidence sources.'}>Connect an evidence source</SectionTitle>
          <div className="grid gap-3 md:grid-cols-3">
            {addableSources.map((t) => (
              <Card key={t.provider}>
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white text-[#181717] shadow-sm">
                    <ProviderLogo provider={t.provider} size={22} />
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium">{t.name}</div>
                    <p className="mt-0.5 text-[12px] font-medium text-ink-2">{t.roles.map((role) => role.replace('_', ' ')).join(' · ')}</p>
                  </div>
                </div>
                <Button className="mt-3" size="sm" disabled={!manage} onClick={() => void act(undefined, 'connect', t)}>Connect</Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8" aria-labelledby="delivery-channels">
          <SectionTitle id="delivery-channels" hint="Choose where Jagr should send alerts and morning briefs. Delivery channels are independent from the evidence Jagr investigates.">Delivery channels</SectionTitle>
          <p className="mb-3 text-[13px] text-ink-2">You can choose more than one when additional channels are available.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {channels.map((c) => (
              <Card key={c.id}>
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white text-[#181717] shadow-sm">
                    <ProviderLogo provider={c.provider} size={22} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">{c.displayName}</div>
                      <Badge tone={c.health === 'healthy' ? 'ok' : c.health === 'unverified' ? 'neutral' : 'high'} dot>{c.health === 'healthy' ? 'Connected' : c.health.replace('_', ' ')}</Badge>
                    </div>
                    <p className="mt-0.5 text-[12px] font-medium text-ink-2">Alerts · Morning briefs</p>
                  </div>
                </div>
                <p className="mt-1 text-[13px] text-ink-3">{c.account ? `${c.account} · ` : ''}{c.healthDetail}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void act(c, 'test')}>Test</Button>
                  <Button size="sm" variant="secondary" disabled={!manage || c.managedBy !== 'workspace'} onClick={() => void act(c, 'reconnect')}>Reconnect</Button>
                  <Button size="sm" variant="secondary" disabled={!manage || c.managedBy !== 'workspace'} onClick={() => void act(c, 'disconnect')}>Disconnect</Button>
                </div>
              </Card>
            ))}
            {!present.has('slack') && slackType && (
              <DeliveryOption provider="slack" name="Slack" description="Jagr uses Slack to deliver alerts and morning briefs." status="Available" disabled={!manage} onConnect={() => void act(undefined, 'connect', slackType)} />
            )}
            <DeliveryOption provider="email" name="Email" description="Email delivery is not implemented in this deployment. Alerts remain available inside Jagr." status="Not available" />
            <DeliveryOption provider="teams" name="Microsoft Teams" description="Teams delivery is not implemented yet." status="Coming soon" />
          </div>
        </section>

      {form && <ConnectForm workspaceId={srv.workspaceId} {...form} onCancel={() => setForm(undefined)} onSuccess={async (connection) => { await srv.refresh(); onConnectionSaved?.(connection); }} />}
    </>
  );
}

export function DeliveryOption({ provider, name, description, status, disabled, onConnect }: { provider: string; name: string; description: string; status: string; disabled?: boolean; onConnect?: () => void }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white text-[#181717] shadow-sm">
          {provider === 'email' ? <Mail size={20} aria-hidden /> : provider === 'teams' ? <span className="text-[13px] font-semibold text-[#6264A7]" aria-hidden>MT</span> : <ProviderLogo provider={provider} size={22} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">{name}</div>
            <Badge tone={status === 'Available' ? 'neutral' : 'neutral'}>{status}</Badge>
          </div>
          <p className="mt-1 text-[13px] text-ink-3">{description}</p>
          {onConnect && <Button className="mt-3" size="sm" disabled={disabled} onClick={onConnect}>Connect</Button>}
        </div>
      </div>
    </Card>
  );
}

const SETUP: Record<string, { purpose: string; access: string; needs: string[]; guide: string[] }> = {
  amplitude: { purpose: 'Investigate product metrics and Amplitude annotations alongside other evidence.', access: 'Jagr uses the read-only Dashboard REST API. It cannot change your Amplitude data.', needs: ['Amplitude data region', 'Project API key and secret key', 'The product signals Jagr should monitor'], guide: ['Open your Amplitude project settings.', 'Find the project API key and secret key.', 'Paste both values below.'] },
  github: { purpose: 'Investigate deployments and published releases for the repositories you choose.', access: 'Jagr reads repository metadata, deployments, and releases. It does not write code or change deployments.', needs: ['Repositories in owner/repository form', 'Deployment environment names', 'A fine-grained read-only personal access token'], guide: ['Create a fine-grained personal access token in GitHub.', 'Limit repository access to the repositories below.', 'Grant read access to metadata, deployments, and contents, then paste the token.'] },
  jira: { purpose: 'Investigate Jira issues and released-version context for one Jira Cloud project.', access: 'Jagr reads project issues and versions. It does not create or edit Jira work.', needs: ['Jira Cloud site URL', 'Project key', 'Atlassian account email and API token'], guide: ['Create an API token from your Atlassian account security settings.', 'Use the account email that owns the token.', 'Paste the email and token below.'] },
  intercom: { purpose: 'Investigate customer-started support conversations as feedback evidence.', access: 'Jagr reads conversations from the selected Intercom workspace. It does not send or edit messages.', needs: ['Intercom data region', 'An Intercom access token', 'Workspace ID only if you want evidence deep links'], guide: ['Create or choose an Intercom app with conversation read access.', 'Copy its access token.', 'Paste the token below.'] },
  sentry: { purpose: 'Investigate errors, crash-free health, releases, and issue evidence from Sentry.', access: 'Jagr needs read-only access to inspect telemetry. It does not need permission to change your Sentry data.', needs: ['Sentry organization slug', 'Numeric project IDs', 'Environment name', 'An auth token with org:read, project:read, and event:read'], guide: ['Open Sentry settings and create an authentication token.', 'Give it org:read, project:read, and event:read permissions.', 'Copy the token and paste it below.'] },
  slack: { purpose: 'Deliver Jagr alerts and morning briefs to one Slack channel.', access: 'Jagr only posts messages. It never reads Slack, and decisions still happen inside Jagr.', needs: ['Slack channel ID', 'A bot token with chat:write', 'The bot added to the destination channel'], guide: ['Create or choose a Slack app with the chat:write scope.', 'Install it to your workspace and add the bot to the channel.', 'Copy the bot token and paste it below.'] },
};

const FIELD_HELP: Record<string, { label: string; help?: string; kind?: 'textarea' | 'select' | 'number' | 'checkbox'; options?: { value: string; label: string }[] }> = {
  repos: { label: 'Repositories', help: 'One per line, as owner/repository.', kind: 'textarea' },
  environments: { label: 'Deployment environments', help: 'Use the exact names from GitHub, such as Production or Preview.', kind: 'textarea' },
  releases: { label: 'Include published releases as context', kind: 'checkbox' },
  site: { label: 'Jira Cloud site', help: 'For example, https://your-site.atlassian.net.' },
  project: { label: 'Project key', help: 'The short key shown in Jira issue IDs, such as SHOP.' },
  region: { label: 'Data region', kind: 'select' },
  appId: { label: 'Workspace ID (optional)', help: 'Used only to link evidence back to your Intercom inbox.' },
  channel: { label: 'Slack channel ID', help: 'Open the channel details and copy its ID, for example C0123456789.' },
  organization: { label: 'Organization', help: 'Your Sentry organization slug from the workspace URL.' },
  projects: { label: 'Projects', help: 'Enter 1–10 numeric Sentry project IDs, separated by commas.' },
  environment: { label: 'Environment (optional)', help: 'For example, production.' },
  issues: { label: 'Include Sentry issues as work-item evidence', kind: 'checkbox' },
  appUrl: { label: 'Amplitude workspace URL', help: 'The URL you use to open this Amplitude workspace.' },
  utcOffsetMinutes: { label: 'Project timezone offset (minutes from UTC)', help: 'Used to align Amplitude’s hourly buckets. UTC is 0.', kind: 'number' },
  annotations: { label: 'Include Amplitude annotations as change evidence', kind: 'checkbox' },
};

const REGION_OPTIONS: Record<string, { value: string; label: string }[]> = {
  amplitude: [{ value: 'us', label: 'United States' }, { value: 'eu', label: 'European Union' }],
  intercom: [{ value: 'us', label: 'United States' }, { value: 'eu', label: 'European Union' }, { value: 'au', label: 'Australia' }],
  sentry: [{ value: 'us', label: 'United States' }, { value: 'de', label: 'Germany' }],
};

/** connect: configuration and credential · reconnect: a new credential only · configure: configuration only (the stored credential is kept). */
type FormMode = 'connect' | 'reconnect' | 'configure';

function ConnectForm({ workspaceId, type, view, mode, onCancel, onSuccess }: { workspaceId: string; type: ConnectionTypeInfo; view?: ConnectionView; mode: FormMode; onCancel: () => void; onSuccess: (connection: ConnectionView) => Promise<void> }) {
  const reconnect = mode === 'reconnect';
  const configure = mode === 'configure' && !!view;
  const toast = useToast();
  const initialConfig = view?.config && Object.keys(view.config).length ? view.config : type.configExample;
  const [fields, setFields] = useState<ConnectionFields>(() => {
    const next = connectionFieldsFromConfig(type.provider, initialConfig);
    if (!view) {
      if (type.provider === 'github') next.repos = '';
      if (type.provider === 'jira') { next.site = ''; next.project = ''; }
      if (type.provider === 'sentry') { next.organization = ''; next.projects = ''; }
      if (type.provider === 'slack') next.channel = '';
    }
    return next;
  });
  const [advanced, setAdvanced] = useState(() => JSON.stringify(initialConfig, null, 2));
  const [cred, setCred] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ConnectionView | undefined>();
  const setup = SETUP[type.provider];
  const submit = async () => {
    setError(undefined);
    let parsed: Record<string, unknown> = {};
    if (!reconnect) {
      let base: Record<string, unknown>;
      try {
        base = JSON.parse(advanced) as Record<string, unknown>;
      } catch {
        setError('The advanced configuration is not valid JSON.');
        return;
      }
      const result = connectionConfigFromFields(type.provider, fields, base);
      if ('error' in result) { setError(result.error); return; }
      parsed = result.config;
    }
    setBusy(true);
    try {
      const r = reconnect && view ? await serverApi.reconnect(workspaceId, view.id, cred) : await serverApi.connect(workspaceId, connectRequest(type.provider, parsed, configure ? undefined : cred));
      toast({ tone: r.check.state === 'connected' && !r.check.warnings?.length ? 'success' : 'warning', title: `${type.name}: ${r.connection.health.replace('_', ' ')}`, body: r.check.detail });
      setCred({});
      await onSuccess(r.connection);
      if (r.check.state === 'connected') setSaved(r.connection);
      else setError(r.check.detail);
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };
  if (saved)
    return (
      <Modal open title={`${type.name} connected`} onClose={onCancel} footer={<Button onClick={onCancel}>Done</Button>}>
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 text-ok" size={20} aria-hidden />
          <div><p className="font-medium text-ink">{type.name} connected</p><p className="mt-1 text-[13px] text-ink-2">{type.kind === 'channel' ? 'Jagr can now deliver alerts and morning briefs to this channel.' : `Jagr can now investigate the ${type.name} signals available to this workspace.`}</p></div>
        </div>
      </Modal>
    );
  return (
    <Modal
      open
      wide
      onClose={() => { if (!busy) onCancel(); }}
      title={`${reconnect ? 'Reconnect' : configure ? 'Edit configuration:' : 'Connect'} ${type.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || (!configure && type.credentialFields.some((f) => !cred[f.key]?.trim()))}>
            {busy ? 'Testing…' : reconnect || configure ? 'Save and test' : 'Connect and test'}
          </Button>
        </>
      }
    >
      {setup && !reconnect && <div><p className="text-[14px] text-ink-2">{setup.purpose}</p>{type.roles.length > 0 && <p className="mt-2 text-[12px] font-medium text-ink-2">Capabilities: {type.roles.map((role) => role.replace('_', ' ')).join(' · ')}</p>}<p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-3">What you’ll need</p><ul className="mt-1 space-y-1 text-[13px] text-ink-2">{setup.needs.map((item) => <li key={item}>• {item}</li>)}</ul></div>}
      <p className="mt-3 text-[13px] text-ink-3">
        {configure
          ? 'Only the configuration changes: the stored credential is kept (it is never shown or sent to this browser). The connection is tested as soon as it is saved.'
          : setup?.access ?? 'The connection is tested as soon as it is saved.'}
      </p>
      {!reconnect && <div className="mt-4 space-y-3">{Object.keys(fields).map((key) => <ConnectionField key={key} provider={type.provider} name={key} value={fields[key]} onChange={(value) => setFields((current) => ({ ...current, [key]: value }))} />)}</div>}
      {!reconnect && ['amplitude', 'sentry'].includes(type.provider) && <details className="mt-4 rounded-lg border border-line bg-subtle/40 p-3"><summary className="cursor-pointer text-[13px] font-medium text-ink-2">Advanced configuration</summary><p className="mt-2 text-[12px] text-ink-3">Signal mappings use the connector’s existing validated schema. Change them only if you already know the required event or telemetry definitions.</p><label className="mt-2 block text-[12px] text-ink-2">Validated connector configuration<textarea aria-label={`${type.name} advanced configuration`} className={cx(inputCls, 'h-36 py-1.5 font-mono text-[12px]')} value={advanced} onChange={(e) => setAdvanced(e.target.value)} spellCheck={false} /></label></details>}
      {!configure && setup && <div className="mt-4 rounded-lg border border-line bg-subtle/40 p-3"><p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Give Jagr read access</p><ol className="mt-2 space-y-1 text-[13px] text-ink-2">{setup.guide.map((item, index) => <li key={item}>{index + 1}. {item}</li>)}</ol></div>}
      {!configure && type.credentialFields.map((f) => (
        <label key={f.key} className="mt-3 block text-[13px] text-ink-2" htmlFor={`credential-${f.key}`}>
          {f.label}
          <input id={`credential-${f.key}`} className={inputCls} type="password" autoComplete="off" value={cred[f.key] ?? ''} onChange={(e) => setCred((c) => ({ ...c, [f.key]: e.target.value }))} />
        </label>
      ))}
      {!configure && <p className="mt-3 text-[12px] text-ink-3">Your credential is sent once to the Jagr server, stored encrypted, and never shown again.</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-crit">{error}</p>}
    </Modal>
  );
}

function ConnectionField({ provider, name, value, onChange }: { provider: string; name: string; value: string | boolean; onChange: (value: string | boolean) => void }) {
  const meta = FIELD_HELP[name] ?? { label: name };
  const id = `connection-${provider}-${name}`;
  if (meta.kind === 'checkbox') return <label className="flex items-center gap-2 text-[13px] text-ink-2" htmlFor={id}><input id={id} type="checkbox" className="size-4 accent-[var(--ink)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />{meta.label}</label>;
  return (
    <label className="block text-[13px] text-ink-2" htmlFor={id}>{meta.label}
      {meta.kind === 'textarea' ? <textarea id={id} aria-describedby={meta.help ? `${id}-help` : undefined} className={cx(inputCls, 'h-20 py-1.5')} value={String(value)} onChange={(e) => onChange(e.target.value)} spellCheck={false} /> : meta.kind === 'select' ? <select id={id} className={inputCls} value={String(value)} onChange={(e) => onChange(e.target.value)}>{(REGION_OPTIONS[provider] ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input id={id} aria-describedby={meta.help ? `${id}-help` : undefined} className={inputCls} type={meta.kind === 'number' ? 'number' : 'text'} value={String(value)} onChange={(e) => onChange(e.target.value)} />}
      {meta.help && <span id={`${id}-help`} className="mt-1 block text-[12px] text-ink-3">{meta.help}</span>}
    </label>
  );
}
