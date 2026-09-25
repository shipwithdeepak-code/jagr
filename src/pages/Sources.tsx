import { ArrowLeft, Info } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import type { ConnectionState, ProviderId, RecordKind } from '@/product/types';
import { externalUrl, PROVIDERS, resolveRef } from '@/product/integrations/adapters';
import { defaultWorld } from '@/product/integrations/world';
import type { IssueRecord, MetricSeries, ReleaseRecord, ReviewRecord } from '@/product/integrations/types';
import { useProduct } from '@/state/productContext';
import { fmtDateTime } from '@/lib/time';
import { ConnectionBadge, ProviderName } from '@/components/product';
import { SeriesChart } from '@/components/charts';
import { Badge, Button, Card, EmptyState, KeyValue, Mono, PageHeader } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ImportedSources } from '@/components/imports';
import { StatusBadge } from '@/components/primitives';
import { SourceGroups, SourcesOverview } from '@/components/sources';
import { sourceViews, type SourceGroup } from '@/product/view/sources';
import { TryYourOwnData, WorkspaceDataBadge } from '@/components/onboarding';
import { WorkspaceTransfer } from '@/components/workspaceTransfer';


export function SourcesPage() {
  const { mode } = useProduct();
  if (mode === 'imported') {
    return (
      <>
        <PageHeader
          title="Sources"
          description="Your product evidence. Jagr normalises metrics, issues, releases and customer feedback into one evidence model, then investigates across them."
          actions={<WorkspaceDataBadge />}
        />
        <ImportedSources />
        <WorkspaceTransfer />
      </>
    );
  }
  return <SampleSources />;
}

function SampleSources() {
  const { state } = useProduct();
  const asOf = state.result?.window.end ?? SAMPLE_WINDOW_END;
  const views = sourceViews(state.connections, { asOf });
  const email = state.connections.find((c) => c.provider === 'email');

  return (
    <>
      <PageHeader
        title="Sources"
        description="The tools you already use. Jagr reads them through one normalised adapter interface, so a Jira issue, a GA4 metric and an App Store review can be correlated as evidence."
        actions={
          <>
            <WorkspaceDataBadge />
            <TryYourOwnData />
          </>
        }
      />
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface px-4 py-3 text-[13px]">
        <Info size={15} className="mt-0.5 shrink-0 text-ink-2" />
        <div className="text-ink-2">
          <span className="font-medium text-ink">No live connections in this build.</span> Every source below runs on deterministic fixture data and is labelled <ConnectionBadge state="simulated" /> — in the Agent Trace every tool result from it is tagged <span className="rounded border border-dashed border-info/50 bg-info-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-info">SIMULATED SOURCE</span>. Live connectors (Amplitude, GitHub, Jira Cloud, Intercom, and Slack for outbound alerts) run on a Jagr server in single-tenant mode, with credentials held server-side — never in this browser app. Connecting them from this page (OAuth) is not built yet. You can simulate an outage, an error or a stale sync to see how Jagr reports gaps instead of guessing.
        </div>
      </div>
      <SourcesOverview views={views} />
      <SourceGroups
        views={views}
        extra={(v) => {
          const watchers = state.watches.filter((w) => w.sources.includes(v.id)).map((w) => w.name);
          return (
            <>
              <p className="mt-2 text-[12px] text-ink-3">
                {watchers.length ? `Used by ${watchers.join(', ')}` : 'Not used by any watch'} · production connector: {PROVIDERS[v.id].realApi}
              </p>
              {v.id === 'jira' && (
                <p className="mt-2 text-[12px] text-ink-3">
                  <span className="font-medium text-ink-2">Real connector: implemented, not configured here.</span> It needs server-side credentials — an API token can’t safely live in a browser app — so this browser build uses simulated Jira data. Jira release dates are day-precision; minute-level timing comes from the stores.
                </p>
              )}
              <SimulationControls id={v.id} group={v.group} />
            </>
          );
        }}
      />
      {email && (
        <section aria-labelledby="channels-h" className="mt-8">
          <h2 id="channels-h" className="text-[13px] font-semibold tracking-tight">
            Delivery channel
          </h2>
          <p className="mt-0.5 mb-3 text-[12.5px] text-ink-3">Where Jagr sends alerts and the morning brief. Not an evidence source.</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px]">
            <span className="font-medium text-ink">{PROVIDERS.email.name}</span>
            <StatusBadge kind="source" value={email.state} />
            <span className="min-w-0 break-words text-ink-3">{email.detail}</span>
            <SimulationControls id="email" group={email.state === 'simulated' ? 'simulated' : email.state === 'unavailable' ? 'unavailable' : email.state === 'error' ? 'error' : 'simulated'} inline />
          </div>
        </section>
      )}
      <p className="mt-6 text-[12.5px] text-ink-3">
        The demo-night replay uses its own adapters — see <Link to="/integrations" className="text-accent hover:underline">demo integrations</Link>.
      </p>
      <WorkspaceTransfer />
    </>
  );
}

/** Where every deep link lands: the underlying record, labelled as simulated, with the live URL it maps to. */
export function SourceRecordPage() {
  const { provider, kind, id } = useParams();
  const ref = { provider: provider as ProviderId, kind: kind as RecordKind, id: decodeURIComponent(id ?? '') };
  const { state, importedWorld } = useProduct();
  // Records resolve against the data this workspace actually investigated.
  const world = importedWorld?.world ?? defaultWorld();
  const rec = provider && kind && id ? resolveRef(world, ref) : undefined;
  const conn = state.connections.find((c) => c.provider === provider);

  if (!rec || !conn) {
    return (
      <EmptyState icon={Info} title="Record not found" action={<Link to="/sources" className="text-[13px] font-medium text-accent">Back to sources</Link>}>
        This link doesn’t point at a record in this workspace’s data.
      </EmptyState>
    );
  }

  return (
    <>
      <button onClick={() => history.back()} className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
        <ArrowLeft size={13} /> Back
      </button>
      <PageHeader
        eyebrow={
          <div className="flex items-center gap-2">
            <ProviderName provider={ref.provider} className="text-[12.5px] font-medium text-ink-2" />
            <Badge>{ref.kind}</Badge>
            <ConnectionBadge state={conn.state} />
          </div>
        }
        title={title(ref.kind, rec)}
      />
      <div className="mb-5 rounded-xl border border-dashed border-info/50 bg-info-soft/40 px-4 py-3 text-[13px]">
        <span className="font-semibold text-info">Simulated record.</span> <span className="text-ink-2">This is fixture data shown inside Jagr. With a live connector, this link opens</span>{' '}
        <Mono className="break-all text-ink">{externalUrl(ref)}</Mono>
      </div>
      <Card>
        {ref.kind === 'metric' ? <MetricView m={rec as MetricSeries} /> : <KeyValue items={fields(ref.kind, rec)} />}
      </Card>
    </>
  );
}

const SAMPLE_WINDOW_END = '2026-09-24T08:05:00.000Z';
const SIMULATED_DETAIL = 'Deterministic fixture data (no credentials configured)';

/** Sample workspace only: put a simulated source into a failure state to see how Jagr reports gaps. */
function SimulationControls({ id, group, inline = false }: { id: ProviderId; group: SourceGroup; inline?: boolean }) {
  const { state, setConnection } = useProduct();
  const toast = useToast();
  const asOf = state.result?.window.end ?? SAMPLE_WINDOW_END;
  const set = (s: ConnectionState, detail: string, label: string, freshAsOf?: string) => {
    setConnection(id, s, detail, freshAsOf ? { freshAsOf } : undefined);
    toast({ tone: 'info', title: `${PROVIDERS[id].name}: ${label}`, body: 'Run monitoring again to see how Jagr handles it.' });
  };
  const staleAt = new Date(Date.parse(asOf) - 192 * 60_000).toISOString();
  const buttons = [
    group !== 'simulated' && { label: 'Use simulated data', run: () => set('simulated', id === 'email' ? 'Simulated outbox — emails are rendered in Jagr, never delivered' : SIMULATED_DETAIL, 'simulated data') },
    group !== 'stale' && id !== 'email' && { label: 'Simulate stale sync', run: () => set('simulated', `${SIMULATED_DETAIL} — last sync simulated 3h 12m before the window ends`, 'stale sync', staleAt) },
    group !== 'unavailable' && { label: 'Simulate outage', run: () => set('unavailable', 'Connection timed out (simulated outage)', 'outage') },
    group !== 'error' && { label: 'Simulate error', run: () => set('error', '401 — token expired (simulated)', 'error') },
  ].filter((b): b is { label: string; run: () => void } => !!b);
  return (
    <div className={inline ? 'ml-auto flex flex-wrap gap-1.5' : 'mt-3 border-t border-dashed border-line pt-3'}>
      {!inline && <div className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Simulation</div>}
      <div className="flex flex-wrap gap-1.5">
        {buttons.map((b) => (
          <Button key={b.label} size="sm" variant="ghost" onClick={b.run}>
            {b.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function title(kind: RecordKind, rec: unknown) {
  if (kind === 'metric') return (rec as MetricSeries).name;
  if (kind === 'issue') return `${(rec as IssueRecord).id} — ${(rec as IssueRecord).title}`;
  if (kind === 'release') return `Release ${(rec as ReleaseRecord).version}`;
  const rv = rec as ReviewRecord;
  return `${rv.rating ? `${rv.rating}★ ` : ''}“${rv.title}”`;
}

function fields(kind: RecordKind, rec: unknown) {
  if (kind === 'issue') {
    const i = rec as IssueRecord;
    return [
      { k: 'Type', v: i.type },
      { k: 'Priority', v: i.priority },
      { k: 'Component', v: i.component },
      { k: 'Labels', v: i.labels.join(', ') || '—' },
      { k: 'Affects version', v: i.affectsVersion ?? '—' },
      { k: 'Reporter', v: i.reporter },
      { k: 'Created', v: fmtDateTime(i.createdAt) },
    ];
  }
  if (kind === 'release') {
    const r = rec as ReleaseRecord;
    return [
      { k: 'Version', v: r.version },
      { k: 'Platform', v: r.platform },
      { k: 'Released', v: fmtDateTime(r.releasedAt) },
      { k: 'Rollout', v: r.rollout ?? 'Full' },
      { k: 'Notes', v: r.notes },
    ];
  }
  const r = rec as ReviewRecord;
  return [
    { k: 'Rating', v: r.rating ? `${r.rating} / 5` : 'Not rated' },
    ...(r.channel ? [{ k: 'Channel', v: r.channel }] : []),
    ...(r.tags?.length ? [{ k: 'Tags', v: r.tags.join(', ') }] : []),
    { k: 'Review', v: r.body },
    { k: 'App version', v: r.version },
    { k: 'Posted', v: fmtDateTime(r.createdAt) },
  ];
}

function MetricView({ m }: { m: MetricSeries }) {
  return (
    <>
      <SeriesChart points={m.points} baseline={m.baseline.mean} stdDev={m.baseline.stdDev} badDirection={m.badDirection} unit={m.unit === 'currency' ? 'currency' : m.unit} label={m.name} />
      <KeyValue
        className="mt-4"
        items={[
          { k: 'Metric id', v: <Mono>{m.id}</Mono> },
          { k: 'Baseline', v: `${m.baseline.mean} ± ${m.baseline.stdDev} (${m.baseline.window.toLowerCase()})` },
          { k: 'Detection threshold', v: m.mode === 'relative' ? `${m.threshold}% in the ${m.badDirection === 'down' ? 'downward' : 'upward'} direction` : `${m.threshold} pts` },
          { k: 'Granularity', v: '15-minute buckets' },
        ]}
      />
    </>
  );
}
