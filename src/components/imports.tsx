import { AlertTriangle, Check, ChevronDown, ChevronRight, Download, FileUp, Info, Lock, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { acceptedCount, IMPORT_KINDS, SUPPORTED_METRICS, type ImportedDataset, type ImportKind } from '@/product/imports/schemas';
import { fmtDate, fmtTime } from '@/lib/time';
import { ConnectionBadge, PROVIDER_ICON } from './product';
import { PROVIDERS } from '@/product/integrations/adapters';
import { Badge, Button, Card, cx, Mono, SectionTitle } from './ui';
import { PRIVACY_NOTICE } from './onboarding';
import { SourceCoverage } from './primitives';

const SAMPLE_FOR: Record<ImportKind, string> = { metrics: '/samples/metrics.csv', issues: '/samples/issues.csv', releases: '/samples/releases.csv', changes: '/samples/changes.csv', feedback: '/samples/reviews.csv' };

/** Sources for a "my data" workspace: upload, validate, inspect — never a silent import. */
export function ImportedSources() {
  const { state, addImport, removeImport, importedWorld, storageError } = useProduct();
  const [params] = useSearchParams();
  const [kind, setKind] = useState<ImportKind>('metrics');
  const [last, setLast] = useState<ImportedDataset | null>(null);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const imports = state.imports ?? [];
  const open = params.get('upload') === '1' || imports.length === 0;
  const spec = IMPORT_KINDS.find((k) => k.kind === kind)!;
  const KINDS_FOR: Partial<Record<string, ImportKind[]>> = { ga4: ['metrics'], jira: ['issues', 'releases', 'changes'], app_store: ['feedback'] };
  const lastImport = (provider: string) =>
    imports
      .filter((d) => KINDS_FOR[provider]?.includes(d.kind))
      .map((d) => d.importedAt)
      .sort()
      .at(-1);

  const onFile = async (file: File) => {
    setReading(true);
    try {
      setLast(addImport(kind, file.name, await file.text()));
    } finally {
      setReading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <>
      <SourceCoverage connections={state.connections} />
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface px-4 py-3 text-[13px] text-ink-2">
        <Lock size={15} className="mt-0.5 shrink-0" />
        <span>{PRIVACY_NOTICE}</span>
      </div>
      {storageError && <div className="mb-4 rounded-xl border border-crit/40 bg-crit-soft/60 px-4 py-3 text-[13px] text-ink">{storageError}</div>}

      <Card className={cx('mb-6', open && 'ring-1 ring-accent/40')}>
        <div className="flex flex-wrap items-center gap-2">
          <FileUp size={16} className="text-accent" />
          <span className="text-[15px] font-semibold">Add source · Upload data</span>
          <span className="text-[12px] text-ink-3">CSV or JSON · up to 5,000 rows per file</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="What kind of data?">
          {IMPORT_KINDS.map((k) => (
            <button
              key={k.kind}
              role="radio"
              aria-checked={kind === k.kind}
              onClick={() => setKind(k.kind)}
              className={cx('rounded-lg border px-3 py-2 text-left text-[13px]', kind === k.kind ? 'border-accent bg-accent-soft/50 font-medium' : 'border-line hover:bg-subtle')}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
          <div className="min-w-0 text-[12.5px] text-ink-2">
            <div className="break-words">
              Required columns: <Mono>{spec.required.join(', ')}</Mono>
              {spec.optional.length > 0 && (
                <>
                  {' '}
                  · optional: <Mono className="text-ink-3">{spec.optional.join(', ')}</Mono>
                </>
              )}
            </div>
            {kind === 'metrics' && <div className="mt-1 text-ink-3">Metrics Jagr can investigate in V1: {SUPPORTED_METRICS.join(', ')}. Timestamps in ISO 8601 (e.g. 2026-09-24T19:00:00Z).</div>}
            <pre className="mt-2 overflow-x-auto rounded-md bg-subtle px-2.5 py-1.5 font-mono text-[11.5px] text-ink-2">{spec.example}</pre>
          </div>
          <div className="flex flex-col gap-2">
            <input ref={input} type="file" accept=".csv,.json,text/csv,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} aria-label={`Upload ${spec.label} file`} />
            <Button variant="primary" icon={FileUp} onClick={() => input.current?.click()} disabled={reading}>
              {reading ? 'Reading…' : `Upload ${spec.label.toLowerCase()}`}
            </Button>
            <a href={SAMPLE_FOR[kind]} download className="inline-flex items-center justify-center gap-1 text-[12px] text-ink-3 hover:text-ink">
              <Download size={12} /> Sample {spec.label.toLowerCase()} file
            </a>
          </div>
        </div>
        {last && <ImportResult d={last} />}
      </Card>

      {importedWorld && importedWorld.notes.length > 0 && (
        <div className="mb-6 space-y-1.5">
          {importedWorld.notes.map((n) => (
            <div key={n} className="flex items-start gap-2 rounded-lg bg-high-soft/50 px-3 py-2 text-[12.5px] text-ink">
              <Info size={13} className="mt-0.5 shrink-0 text-high" />
              {n}
            </div>
          ))}
        </div>
      )}

      <SectionTitle hint="Everything Jagr investigates in this workspace. Remove a file to take it out of the next run.">Imported files</SectionTitle>
      {imports.length === 0 ? (
        <div className="mb-8 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">Jagr needs evidence to investigate. Upload a file above — or try the sample files.</div>
      ) : (
        <Card padded={false} className="mb-8 overflow-hidden">
          {imports.map((d) => (
            <ImportRow key={d.id} d={d} onRemove={() => removeImport(d.id)} />
          ))}
        </Card>
      )}

      <SectionTitle hint="How each evidence channel is fed in this workspace.">Source status</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        {state.connections
          .filter((c) => c.provider !== 'email')
          .map((c) => {
            const Icon = PROVIDER_ICON[c.provider];
            return (
              <Card key={c.provider}>
                <div className="flex items-start gap-3">
                  <Icon size={16} className="mt-0.5 text-ink-2" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold">{c.label?.name ?? PROVIDERS[c.provider].name}</span>
                      <ConnectionBadge state={c.state} />
                    </div>
                    <div className="mt-0.5 text-[12px] break-words text-ink-2">{c.detail}</div>
                    {c.state === 'imported' && lastImport(c.provider) && (
                      <div className="mt-1 text-[11.5px] text-ink-3">
                        Last imported {fmtDate(lastImport(c.provider)!)} {fmtTime(lastImport(c.provider)!)} · validated on upload
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        <Card>
          <div className="flex items-start gap-3">
            <Info size={16} className="mt-0.5 text-ink-2" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-semibold">Jira Cloud</span>
                <ConnectionBadge state="not_configured" />
              </div>
              <div className="mt-0.5 text-[12px] text-ink-3">A real Jira Cloud connector exists, but connecting it needs server-side credentials this deployment does not have. Export issues/releases as CSV and import them instead.</div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

function ImportResult({ d }: { d: ImportedDataset }) {
  const ok = acceptedCount(d);
  if (d.error) {
    return (
      <div className="mt-4 flex items-start gap-2 rounded-lg border border-crit/40 bg-crit-soft/50 px-3 py-2.5 text-[13px]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-crit" />
        <span>
          <span className="font-medium">{d.filename} was not imported.</span> {d.error}
        </span>
      </div>
    );
  }
  return (
    <div className={cx('mt-4 rounded-lg border px-3 py-2.5 text-[13px]', d.rejected.length ? 'border-high/40 bg-high-soft/40' : 'border-ok/40 bg-ok-soft/40')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">{d.filename}</span>
        <span className="text-ink-2">{d.format.toUpperCase()} · {d.totalRows} rows</span>
        <span className="inline-flex items-center gap-1 text-ok">
          <Check size={13} /> Imported: {ok}
        </span>
        <span className={d.rejected.length ? 'font-medium text-high' : 'text-ink-3'}>Rejected: {d.rejected.length}</span>
      </div>
      <div className="mt-1 text-[12px] text-ink-3">
        Detected columns: <Mono>{d.columns.join(', ') || '—'}</Mono>
      </div>
      {d.notes.map((n) => (
        <div key={n} className="mt-1 text-[12px] text-ink-2">
          {n}
        </div>
      ))}
      {d.rejected.length > 0 && <RejectedRows d={d} initiallyOpen />}
    </div>
  );
}

function RejectedRows({ d, initiallyOpen = false }: { d: ImportedDataset; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const reasons = new Map<string, number>();
  for (const r of d.rejected) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[12px] font-medium text-high hover:underline">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {d.rejected.length} row{d.rejected.length === 1 ? '' : 's'} rejected — {[...reasons.entries()].map(([r, n]) => `${n} × ${r.replace(/\.$/, '')}`).join('; ').slice(0, 160)}
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-surface">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-subtle text-ink-3">
              <tr>
                <th className="px-2 py-1 font-medium">Line</th>
                <th className="px-2 py-1 font-medium">Reason</th>
                <th className="px-2 py-1 font-medium">Row</th>
              </tr>
            </thead>
            <tbody>
              {d.rejected.map((r) => (
                <tr key={r.line} className="border-t border-line align-top">
                  <td className="px-2 py-1 font-mono text-ink-3">{r.line}</td>
                  <td className="px-2 py-1">{r.reason}</td>
                  <td className="px-2 py-1 font-mono text-[11px] text-ink-2">{Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(' · ').slice(0, 200)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportRow({ d, onRemove }: { d: ImportedDataset; onRemove: () => void }) {
  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Badge tone="accent">{IMPORT_KINDS.find((k) => k.kind === d.kind)!.label}</Badge>
        <span className="font-medium">{d.filename}</span>
        <span className="text-ink-3">
          {fmtDate(d.importedAt)} {fmtTime(d.importedAt)}
        </span>
        <span className="text-ink-2">
          {acceptedCount(d)} imported · <span className={d.rejected.length ? 'font-medium text-high' : ''}>{d.rejected.length} rejected</span>
        </span>
        <Button size="sm" variant="ghost" icon={Trash2} className="ml-auto" onClick={onRemove} aria-label={`Remove ${d.filename}`}>
          Remove
        </Button>
      </div>
      {d.rejected.length > 0 && <RejectedRows d={d} />}
    </div>
  );
}
