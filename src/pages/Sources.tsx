import { ArrowLeft, Info, Lock } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import type { ConnectionState, ProviderId, RecordKind } from '@/product/types';
import { externalUrl, PROVIDERS, resolveRef } from '@/product/integrations/adapters';
import { defaultWorld } from '@/product/integrations/world';
import type { IssueRecord, MetricSeries, ReleaseRecord, ReviewRecord } from '@/product/integrations/types';
import { useProduct } from '@/state/productContext';
import { fmtDateTime } from '@/lib/time';
import { ConnectionBadge, PROVIDER_ICON, ProviderName } from '@/components/product';
import { SeriesChart } from '@/components/charts';
import { Badge, Button, Card, EmptyState, KeyValue, Mono, PageHeader } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ImportedSources } from '@/components/imports';
import { TryYourOwnData, WorkspaceDataBadge } from '@/components/onboarding';

const OPS: Record<string, string> = { metrics: 'getMetrics()', issues: 'getIssues()', releases: 'getReleases()', reviews: 'getReviews()', events: 'getEvents()', changes: 'getChanges()', send_email: 'send()' };

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
      </>
    );
  }
  return <SampleSources />;
}

function SampleSources() {
  const { state, setConnection } = useProduct();
  const toast = useToast();
  const set = (p: ProviderId, s: ConnectionState, detail: string) => {
    setConnection(p, s, detail);
    toast({ tone: 'info', title: `${PROVIDERS[p].name}: ${s}`, body: 'Re-run monitoring to see how Jagr handles it.' });
  };

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
          <span className="font-medium text-ink">No live connections in this build.</span> Every source below runs on deterministic fixture data and is labelled <ConnectionBadge state="simulated" /> — in the Agent Trace every tool result from it is tagged <span className="rounded border border-dashed border-info/50 bg-info-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-info">SIMULATED SOURCE</span>. A real Jira Cloud connector exists behind the same interface (see Jira). OAuth and credentials are not implemented yet; the adapters are shaped so real connectors drop in without changing the engine. You can simulate an outage to see how Jagr reports gaps instead of guessing.
        </div>
      </div>
      <div className="mb-5 flex flex-wrap gap-4 text-[12px] text-ink-3">
        {(['connected', 'simulated', 'unavailable', 'error'] as ConnectionState[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <ConnectionBadge state={s} />
            {s === 'connected' ? 'live credentials' : s === 'simulated' ? 'fixture data, clearly labelled' : s === 'unavailable' ? 'cannot be reached — recorded as a gap' : 'responded with an error — recorded as a gap'}
          </span>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {state.connections.map((c) => {
          const meta = PROVIDERS[c.provider];
          const Icon = PROVIDER_ICON[c.provider];
          const watchers = state.watches.filter((w) => w.sources.includes(c.provider)).map((w) => w.name);
          return (
            <Card key={c.provider}>
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-subtle text-ink-2">
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold">{meta.name}</span>
                    <ConnectionBadge state={c.state} />
                  </div>
                  <div className="text-[12px] text-ink-3">{c.detail}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {meta.capabilities.map((cap) => (
                  <Mono key={cap} className="rounded bg-subtle px-1.5 py-0.5 text-ink-2">
                    {OPS[cap]}
                  </Mono>
                ))}
              </div>
              {c.provider === 'jira' && (
                <div className="mt-3 rounded-lg border border-line bg-subtle/60 px-3 py-2 text-[12px] text-ink-2">
                  <span className="font-medium text-ink">Real connector: implemented, not configured.</span> <Mono>JiraCloudAdapter</Mono> (REST v3 <Mono>search/jql</Mono> + project versions) is built and tested against mocked Jira responses. It needs server-side credentials — an API token can’t safely live in a browser app — so this build uses simulated Jira data. Jira release dates are day-precision; minute-level release timing comes from the stores.
                </div>
              )}
              <div className="mt-2 text-[12px] text-ink-3">
                {c.provider === 'email' ? 'Used for alerts and the morning brief.' : watchers.length ? `Used by ${watchers.join(', ')}` : 'Not used by any watch'} · production connector: {meta.realApi}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                <Button size="sm" icon={Lock} disabled title="OAuth is not implemented in this build">
                  Connect
                </Button>
                {c.state !== 'simulated' && (
                  <Button size="sm" onClick={() => set(c.provider, 'simulated', c.provider === 'email' ? 'Simulated outbox — emails are rendered in Jagr, never delivered' : 'Deterministic fixture data (no credentials configured)')}>
                    Use simulated data
                  </Button>
                )}
                {c.state !== 'unavailable' && (
                  <Button size="sm" variant="ghost" onClick={() => set(c.provider, 'unavailable', 'Connection timed out (simulated outage)')}>
                    Simulate outage
                  </Button>
                )}
                {c.state !== 'error' && (
                  <Button size="sm" variant="ghost" onClick={() => set(c.provider, 'error', '401 — token expired (simulated)')}>
                    Simulate error
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-6 text-[12.5px] text-ink-3">
        The demo-night replay uses its own adapters — see <Link to="/integrations" className="text-accent hover:underline">demo integrations</Link>.
      </p>
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

function title(kind: RecordKind, rec: unknown) {
  if (kind === 'metric') return (rec as MetricSeries).name;
  if (kind === 'issue') return `${(rec as IssueRecord).id} — ${(rec as IssueRecord).title}`;
  if (kind === 'release') return `Release ${(rec as ReleaseRecord).version}`;
  return `${(rec as ReviewRecord).rating}★ “${(rec as ReviewRecord).title}”`;
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
    { k: 'Rating', v: `${r.rating} / 5` },
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
