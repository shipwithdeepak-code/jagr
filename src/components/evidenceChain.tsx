import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ConnectionState, ProviderId } from '@/product/types';
import { CHAIN_STAGE_LABEL, type ChainLink, type ChainProvenance, type ChainStage, type EvidenceChain as Chain } from '@/product/view/evidenceChain';
import { fmtTime } from '@/lib/time';
import { ProviderName } from './product';
import { StatusBadge } from './primitives';
import { cx } from './ui';

/**
 * Marker per stage. Kinds are told apart by shape and weight, not by colour: evidence kinds are not
 * severities, so none of them borrows an attention colour.
 */
const MARKER: Record<ChainStage, string> = {
  signal: 'size-2.5 rotate-45 rounded-[2px] bg-ink',
  observed: 'size-2 rounded-full bg-ink',
  correlated: 'size-2.5 rounded-full border-2 border-ink bg-surface',
  inferred: 'size-2.5 rounded-full border-2 border-dashed border-ink-2 bg-surface',
  assumed: 'size-2.5 rounded-full border-2 border-dotted border-ink-3 bg-surface',
  unknown: 'size-2.5 rounded-full border border-ink-3 bg-surface',
  attention: 'size-2.5 rotate-45 rounded-[2px] border-2 border-ink bg-surface',
  recommendation: 'size-2 rounded-[1px] bg-ink',
  approval: 'size-2.5 rounded-[3px] border-2 border-ink bg-surface',
};

const STAGE_TONE: Partial<Record<ChainStage, string>> = { signal: 'text-ink', observed: 'text-ink-2', correlated: 'text-ink-2' };

/** Data mode in words, never implied: SIMULATED, USER IMPORT, LIVE — or a gap. */
function modeLabel(state?: ConnectionState): string | undefined {
  if (!state) return undefined;
  if (state === 'connected') return 'live';
  if (state === 'imported') return 'user import';
  if (state === 'simulated') return 'simulated';
  return state.replace('_', ' ');
}

function Provenance({ p, stateOf }: { p: ChainProvenance; stateOf: (p: ProviderId) => ConnectionState | undefined }) {
  if (!p.sources.length && !p.at && !p.link) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-3">
      {p.sources.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <ProviderName provider={s} short />
          {/* The mode recorded with the evidence wins: an old investigation keeps the data mode it was built on. */}
          {modeLabel(p.mode ?? stateOf(s)) && <span className="text-[12px] font-semibold tracking-[0.06em] uppercase">{modeLabel(p.mode ?? stateOf(s))}</span>}
        </span>
      ))}
      {p.at && <span className="num font-mono">{fmtTime(p.at)} UTC</span>}
      {p.freshAsOf && <span className="font-medium text-high">data only to {fmtTime(p.freshAsOf)} UTC</span>}
      {p.records && p.records > 1 && <span className="num">{p.records} records</span>}
      {p.query && <span>query: {p.query}</span>}
      {p.link && (
        <Link to={p.link.href} className="interactive inline-flex items-center gap-0.5 font-medium text-accent hover:underline" title={p.link.simulated ? 'Opens the simulated record' : 'Opens the record'}>
          Open record <ChevronRight size={11} aria-hidden />
        </Link>
      )}
    </p>
  );
}

function LinkBody({ link, stateOf }: { link: ChainLink; stateOf: (p: ProviderId) => ConnectionState | undefined }) {
  if (link.stage === 'attention' && link.attention) {
    return (
      <div>
        <StatusBadge kind="attention" value={link.attention} size="md" />
        {link.note && <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{link.note}</p>}
      </div>
    );
  }
  const decisionTone = link.decision === 'awaiting' ? 'text-high' : link.decision === 'approved' || link.decision === 'done' || link.decision === 'executed' ? 'text-ok' : link.decision === 'rejected' ? 'text-ink-3' : 'text-ink-2';
  return (
    <div>
      <p className={cx('text-[14px] leading-snug', link.quiet ? 'text-ink-2' : link.stage === 'inferred' || link.stage === 'assumed' ? 'text-ink-2' : link.stage === 'unknown' ? 'text-ink-2 italic' : 'text-ink', link.stage === 'recommendation' && 'font-medium')}>{link.text}</p>
      {link.note && <p className={cx('mt-0.5 text-[13px] leading-snug', link.stage === 'approval' ? cx('font-medium', decisionTone) : 'text-ink-2')}>{link.note}</p>}
      {link.decision === 'awaiting' && (
        <a href={`#approve-${link.id.replace(/^appr-/, '')}`} className="interactive mt-1 inline-flex items-center gap-0.5 text-[12px] font-medium text-accent hover:underline">
          Review approval <ChevronRight size={11} aria-hidden />
        </a>
      )}
      {link.provenance && <Provenance p={link.provenance} stateOf={stateOf} />}
    </div>
  );
}

/**
 * The evidence chain: signal → observed → correlated → inferred → unknown → attention →
 * recommendation → approval. Structured reasoning from recorded fields — never chain of thought.
 */
export function EvidenceChain({ chain, stateOf, stages, label = 'Evidence chain' }: { chain: Chain; stateOf: (p: ProviderId) => ConnectionState | undefined; stages?: readonly ChainStage[]; label?: string }) {
  const shown = stages ? chain.stages.filter((s) => stages.includes(s)) : chain.stages;
  if (!shown.length) return null;
  return (
    <ol aria-label={label} className="relative">
      {shown.map((stage, i) => {
        const links = chain.links.filter((l) => l.stage === stage);
        const findings = links.filter((l) => !l.quiet || stage !== 'observed');
        const quiet = stage === 'observed' ? links.filter((l) => l.quiet) : [];
        const last = i === shown.length - 1;
        return (
          <li key={stage} className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0 sm:grid-cols-[14px_104px_minmax(0,1fr)] sm:gap-x-4">
            {/* The rail: one continuous line from the signal to the approval. */}
            {!last && <span aria-hidden className="absolute top-3 bottom-0 left-[6px] w-px bg-line-strong" />}
            <span aria-hidden className="relative z-[1] flex h-5 items-center justify-center">
              <span className={MARKER[stage]} />
            </span>
            <h3 className={cx('pt-0.5 text-[12px] font-semibold tracking-[0.08em] uppercase max-sm:col-start-2', STAGE_TONE[stage] ?? 'text-ink-3')}>{CHAIN_STAGE_LABEL[stage]}</h3>
            <div className="min-w-0 space-y-3 max-sm:col-start-2 max-sm:mt-1">
              {findings.map((l) => (
                <LinkBody key={l.id} link={l} stateOf={stateOf} />
              ))}
              {quiet.length > 0 && (
                <details className="group">
                  <summary className="interactive inline-flex cursor-pointer list-none items-center gap-1 rounded text-[13px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={12} aria-hidden className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                    {quiet.length} other check{quiet.length === 1 ? '' : 's'} came back normal
                  </summary>
                  <div className="mt-2 space-y-2.5 border-l border-line pl-3">
                    {quiet.map((l) => (
                      <LinkBody key={l.id} link={l} stateOf={stateOf} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
