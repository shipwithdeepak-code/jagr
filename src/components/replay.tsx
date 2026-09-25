import { ChevronLeft, ChevronRight, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionDecision, WatchInvestigation } from '@/product/types';
import { defaultReplayPass, REPLAY_STAGE_LABEL, replayFrames, replayPasses, type ReplayStage } from '@/product/view/replay';
import { fmtTime } from '@/lib/time';
import { ProviderName } from './product';
import { Button, cx } from './ui';

const STEP_MS = 700;

const STAGE_TONE: Partial<Record<ReplayStage, string>> = {
  signal: 'text-crit',
  hypothesis: 'text-accent',
  attention: 'text-ink',
  action: 'text-high',
};

/**
 * Replays a recorded investigation pass from the stored trace — one step at a time, nothing re-run.
 * "Run monitoring again" is a different thing and is kept visibly separate: it re-reads the sources.
 */
export function InvestigationReplay({ inv, decisions, onRunAgain, running }: { inv: WatchInvestigation; decisions: Record<string, ActionDecision>; onRunAgain: () => void; running: boolean }) {
  const passes = useMemo(() => replayPasses(inv), [inv]);
  const original = useMemo(() => defaultReplayPass(inv), [inv]);
  const [pass, setPass] = useState(original);
  const frames = useMemo(() => replayFrames(inv, decisions, pass), [inv, decisions, pass]);
  const [shown, setShown] = useState(1);
  const [playing, setPlaying] = useState(false);
  const list = useRef<HTMLOListElement>(null);

  const total = frames.length;
  const done = shown >= total;
  const current = frames[Math.min(shown, total) - 1];

  useEffect(() => {
    setShown(1);
    setPlaying(false);
  }, [pass]);

  useEffect(() => {
    if (!playing) return;
    if (done) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setShown((n) => Math.min(total, n + 1)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, shown, done, total]);

  // Keep the newest step in view inside the replay panel — never scroll the page.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const info = passes.find((p) => p.pass === pass);
  if (!total) {
    return <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-2">This investigation has no recorded steps to replay.</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold">Replay original investigation</h3>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {pass === original ? 'The pass that reached this verdict' : `Pass ${pass}`} · {info && `${fmtTime(info.at)} UTC`} · from the stored trace — nothing is re-run.
          </p>
        </div>
        {passes.length > 1 && (
          <label className="flex items-center gap-2 text-[12px] text-ink-3">
            Pass
            <select value={pass} onChange={(e) => setPass(Number(e.target.value))} className="h-7 rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink">
              {passes.map((p) => (
                <option key={p.pass} value={p.pass}>
                  {p.pass} · {fmtTime(p.at)}
                  {p.attention ? ` · ${p.attention}` : ' · re-check'}
                  {p.pass === original ? ' (original)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">
        <Button size="sm" variant="primary" icon={playing ? Pause : Play} onClick={() => (done ? (setShown(1), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? 'Pause' : done ? 'Replay again' : shown > 1 ? 'Resume' : 'Play'}
        </Button>
        <Button size="sm" variant="ghost" icon={ChevronLeft} onClick={() => (setPlaying(false), setShown((n) => Math.max(1, n - 1)))} disabled={shown <= 1} aria-label="Previous step">
          <span className="max-sm:sr-only">Back</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (setPlaying(false), setShown((n) => Math.min(total, n + 1)))} disabled={done} aria-label="Next step">
          <span className="max-sm:sr-only">Next</span> <ChevronRight size={13} aria-hidden />
        </Button>
        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => (setPlaying(false), setShown(1))} disabled={shown <= 1} aria-label="Restart replay">
          <span className="max-sm:sr-only">Restart</span>
        </Button>
        <span className="num ml-auto text-[12px] text-ink-3">
          Step {Math.min(shown, total)} of {total}
        </span>
      </div>

      <div className="mx-4 mt-2.5 h-0.5 overflow-hidden rounded-full bg-line sm:mx-5" aria-hidden>
        <div className="h-full bg-ink transition-[width] duration-200 ease-out motion-reduce:transition-none" style={{ width: `${(Math.min(shown, total) / total) * 100}%` }} />
      </div>

      <p className="sr-only" aria-live="polite">
        {current && `Step ${Math.min(shown, total)} of ${total}: ${REPLAY_STAGE_LABEL[current.stage]}. ${current.title}`}
      </p>

      <ol ref={list} aria-label="Replayed steps" className="max-h-[26rem] overflow-y-auto px-4 py-3 sm:px-5">
        {frames.slice(0, shown).map((f, i) => {
          const latest = i === shown - 1;
          return (
            <li key={f.id} className={cx('animate-reveal grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 rounded-lg px-2 py-2 sm:grid-cols-[44px_150px_minmax(0,1fr)]', latest && 'bg-subtle/70')}>
              <span className="num pt-px font-mono text-[11.5px] text-ink-3">{fmtTime(f.at)}</span>
              <span className={cx('pt-px text-[10.5px] font-semibold tracking-[0.08em] uppercase max-sm:col-start-2', f.warn ? 'text-high' : STAGE_TONE[f.stage] ?? 'text-ink-3')}>{REPLAY_STAGE_LABEL[f.stage]}</span>
              <div className="min-w-0 max-sm:col-start-2">
                <p className={cx('text-[13px] leading-snug break-words', f.warn ? 'text-high' : 'text-ink', (f.stage === 'attention' || f.stage === 'action') && 'font-medium')}>{f.title}</p>
                {f.detail && <p className="mt-0.5 text-[12px] leading-snug break-words text-ink-2">{f.detail}</p>}
                {f.sources.length > 0 && (
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-ink-3">
                    {f.sources.map((s) => (
                      <ProviderName key={s} provider={s} short />
                    ))}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-subtle/40 px-4 py-3 sm:px-5">
        <Button size="sm" icon={RefreshCw} onClick={onRunAgain} disabled={running}>
          {running ? 'Running…' : 'Run monitoring again'}
        </Button>
        <p className="min-w-0 flex-1 text-[12px] text-ink-3">Run again re-checks every watch against the current data and planner. Its results can differ from this replay.</p>
      </div>
    </div>
  );
}
