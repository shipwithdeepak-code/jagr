import { Check, Circle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { STAGES, type RunProgress } from '@/product/progress';
import { fmtTime } from '@/lib/time';
import { cx } from './ui';

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * What the run is doing right now. Every stage state comes from a trace step the engine actually
 * recorded — stages are never ticked ahead of the work, and a stage the run doesn't need stays
 * unticked.
 */
export function RunProgressPanel({ progress, planner }: { progress: RunProgress; planner: string }) {
  const elapsed = useElapsed(progress.startedAt);
  const inv = progress.investigation;
  const activeLabel = STAGES.find((s) => s.id === progress.active)?.label;
  return (
    <section aria-label="Monitoring run in progress" className="animate-reveal relative overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden>
        <div className="progress-sweep h-full w-2/5 bg-accent/70" />
      </div>
      <div className="px-4 pt-3.5 pb-3 sm:px-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div role="status" aria-live="polite" className="min-w-0 flex-1 text-[14px] font-medium text-ink">
            {inv ? (
              <>
                {inv.firstPass ? 'Investigating' : 'Re-checking'} <span className="text-ink">{inv.title}</span>
                {activeLabel && <span className="font-normal text-ink-2"> — {activeLabel.toLowerCase()}</span>}
              </>
            ) : progress.job ? (
              'Checking watches for meaningful changes'
            ) : (
              'Starting monitoring run'
            )}
          </div>
          <div className="num text-[12px] text-ink-3">
            {progress.toolCalls} tool call{progress.toolCalls === 1 ? '' : 's'} · {elapsed}
          </div>
        </div>
        <div className="mt-0.5 text-[12px] text-ink-3">
          {progress.job ? (
            <>
              Scheduled check <span className="num">{progress.job.index + 1}</span> of <span className="num">{progress.job.total}</span> · {progress.job.watchName} · {fmtTime(progress.job.at)} in the data
            </>
          ) : (
            'Preparing sources'
          )}
          {' · '}
          {planner}
        </div>

        {inv && (
          <ol className="mt-3 grid gap-x-3 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" aria-label="Investigation stages">
            {STAGES.map((s) => {
              const reached = progress.reached.includes(s.id);
              const active = progress.active === s.id;
              return (
                <li key={s.id} className={cx('flex items-center gap-1.5 text-[12px]', active ? 'font-medium text-ink' : reached ? 'text-ink-2' : 'text-ink-3')}>
                  {active ? (
                    <Loader2 size={12} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
                  ) : reached ? (
                    <Check size={12} className="shrink-0 text-ok" aria-hidden />
                  ) : (
                    <Circle size={10} className="mx-px shrink-0 opacity-50" aria-hidden />
                  )}
                  <span>{s.label}</span>
                  <span className="sr-only">{active ? '(in progress)' : reached ? '(done)' : '(not reached)'}</span>
                </li>
              );
            })}
          </ol>
        )}
        {progress.latest && <div className="mt-2.5 truncate border-t border-line pt-2 font-mono text-[12px] text-ink-3">{progress.latest}</div>}
      </div>
    </section>
  );
}
