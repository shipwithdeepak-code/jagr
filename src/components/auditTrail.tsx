import { ChevronRight } from 'lucide-react';
import type { SourceConnection, TraceStep } from '@/product/types';
import { AUDIT_STAGE_LABEL, AUDIT_TONE, auditEvents, type AuditTone } from '@/product/view/audit';
import { fmtTime } from '@/lib/time';
import { ProviderName } from './product';
import { SourceStateTag } from './agent';
import { cx } from './ui';

const TONE: Record<AuditTone, { label: string; dot: string; text: string }> = {
  signal: { label: 'text-crit', dot: 'bg-crit', text: 'text-ink font-medium' },
  work: { label: 'text-ink-3', dot: 'bg-ink-3', text: 'text-ink' },
  finding: { label: 'text-accent', dot: 'bg-accent', text: 'text-ink' },
  quiet: { label: 'text-ink-3', dot: 'bg-line-strong', text: 'text-ink-2' },
  warn: { label: 'text-high', dot: 'bg-high', text: 'text-ink' },
  conclusion: { label: 'text-ink', dot: 'bg-ink', text: 'text-ink font-medium' },
  human: { label: 'text-ok', dot: 'bg-ok', text: 'text-ink font-medium' },
};

/**
 * One readable line per recorded step: TIME · STAGE · what Jagr did · what came back · source.
 * Details (query, planner summary, validator verdict) expand on demand. No hidden reasoning is shown
 * because none is recorded — only the summaries the planner was asked to give.
 */
export function AuditTrail({ steps, stateOf }: { steps: TraceStep[]; stateOf: (p?: string) => SourceConnection['state'] | undefined }) {
  const events = auditEvents(steps);
  let lastTime = '';
  return (
    <ol aria-label="Audit trail" className="divide-y divide-line/70">
      {events.map((e) => {
        const tone = TONE[AUDIT_TONE[e.stage]];
        const time = fmtTime(e.at);
        const showTime = time !== lastTime;
        lastTime = time;
        const isCall = e.stage === 'investigating' && e.sources.length > 0;
        return (
          <li key={e.id} className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 px-4 py-2.5 sm:grid-cols-[44px_128px_minmax(0,1fr)] sm:px-5">
            <span className={cx('num pt-px font-mono text-[11.5px] text-ink-3', !showTime && 'invisible')}>{time}</span>
            <span className={cx('flex items-center gap-1.5 pt-px text-[10.5px] font-semibold tracking-[0.08em] uppercase max-sm:col-start-2', tone.label)}>
              <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', tone.dot)} />
              {AUDIT_STAGE_LABEL[e.stage]}
            </span>
            <div className="min-w-0 max-sm:col-start-2 max-sm:mt-0.5">
              <p className={cx('text-[13px] leading-snug break-words', tone.text)}>{e.action}</p>
              {e.result && <p className="mt-0.5 text-[12.5px] leading-snug break-words text-ink-2">{e.result}</p>}
              {e.sources.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
                  {e.sources.map((s) => (
                    <ProviderName key={s} provider={s} short />
                  ))}
                  {isCall && <SourceStateTag state={stateOf(e.sources[0])} />}
                </p>
              )}
              {e.detail.length > 0 && (
                <details className="group mt-1">
                  <summary className="interactive inline-flex cursor-pointer list-none items-center gap-1 rounded text-[11.5px] font-medium text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={11} aria-hidden className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                    Details
                  </summary>
                  <dl className="mt-1.5 grid gap-x-3 gap-y-1 border-l border-line pl-3 text-[12px] sm:grid-cols-[max-content_minmax(0,1fr)]">
                    {e.detail.map((d) => (
                      <div key={d.label} className="contents">
                        <dt className="text-ink-3">{d.label}</dt>
                        <dd className="break-words text-ink-2">{d.text}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
