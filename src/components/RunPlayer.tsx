import { Check, Pause, Play, SkipForward, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentStage, OvernightRun } from '@/domain/types';
import { fmt12h, fmtTime } from '@/lib/time';
import { cx } from './ui';
import { LogoMark } from './Logo';

/**
 * Replays a completed overnight run in compressed time. Every line shown is a real event
 * emitted by the orchestrator — nothing here is decorative loading.
 */

const PIPELINE = [
  'PM leaves · Jagr starts',
  'Signals arrive',
  'Detect anomalies',
  'Investigate',
  'Gather evidence',
  'Form hypothesis',
  'Evaluate confidence',
  'Assess risk',
  'Create task',
  'Create incident',
  'Request approval',
  'Morning brief',
];

function pipelineIndex(e: AgentEvent): number {
  const map: Partial<Record<AgentStage, number>> = { start: 0, collect: 1, detect: 2, prioritize: 2, investigate: 3, evidence: 4, hypothesis: 5, confidence: 6, risk: 7, decide: 7, approval: 10, brief: 11 };
  if (e.stage === 'act') {
    if (e.action.includes('incident')) return 9;
    if (e.action.includes('task')) return 8;
    return 8;
  }
  return map[e.stage] ?? 1;
}

const STAGE_LABEL: Partial<Record<AgentStage, string>> = {
  start: 'Start',
  collect: 'Collect',
  detect: 'Detect',
  prioritize: 'Prioritize',
  investigate: 'Investigate',
  evidence: 'Evidence',
  hypothesis: 'Hypothesis',
  confidence: 'Confidence',
  risk: 'Risk',
  decide: 'Decide',
  act: 'Act',
  approval: 'Approval',
  brief: 'Brief',
};

interface Beat {
  event: AgentEvent;
  ms: number;
}

function schedule(events: AgentEvent[], targetMs: number): Beat[] {
  const shown = events.filter((e) => !(e.stage === 'collect' && e.routine) && e.tool !== 'issueTracker.findOpenByFingerprint');
  const weight = (e: AgentEvent) => {
    if (e.routine) return 0.35;
    if (e.stage === 'detect' && e.status === 'warning') return 2.4;
    if (['hypothesis', 'confidence', 'approval'].includes(e.stage)) return 1.8;
    if (e.stage === 'act') return 1.6;
    if (e.stage === 'risk') return 0.6;
    return 1;
  };
  const total = shown.reduce((a, e) => a + weight(e), 0);
  return shown.map((e) => ({ event: e, ms: (weight(e) / total) * targetMs }));
}

export function RunPlayer({ run, mode, onDone, onClose }: { run: OvernightRun; mode: 'demo' | 'quick'; onDone: () => void; onClose: () => void }) {
  const INTRO = mode === 'demo' ? 3200 : 600;
  const OUTRO = mode === 'demo' ? 2600 : 900;
  const beats = useMemo(() => schedule(run.events, mode === 'demo' ? 26_000 : 7_500), [run, mode]);
  const [idx, setIdx] = useState(-1); // -1 = intro
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (paused) return;
    if (finished) {
      const t = setTimeout(() => doneRef.current(), OUTRO);
      return () => clearTimeout(t);
    }
    const wait = idx < 0 ? INTRO : beats[idx]?.ms ?? 0;
    const t = setTimeout(() => {
      if (idx + 1 >= beats.length) setFinished(true);
      else setIdx(idx + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [idx, paused, finished, beats, INTRO, OUTRO]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [idx]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const visible = idx < 0 ? [] : beats.slice(0, idx + 1).map((b) => b.event);
  const current = visible.at(-1);
  const clock = finished ? run.brief.generatedAt : current?.at ?? run.startedAt;
  const reached = visible.reduce((m, e) => Math.max(m, pipelineIndex(e)), idx < 0 ? -1 : 0);
  const activeStage = finished ? PIPELINE.length : reached;
  const nightMs = Date.parse(run.brief.window.end) - Date.parse(run.brief.window.start);
  const progress = Math.min(1, Math.max(0, (Date.parse(clock) - Date.parse(run.brief.window.start)) / nightMs));

  const sweeps = visible.filter((e) => e.stage === 'detect').length;
  const counters = [
    { label: 'Signals checked', value: (sweeps * run.stats.signalsMonitored).toLocaleString('en-US') },
    { label: 'Anomalies', value: visible.filter((e) => e.stage === 'detect' && e.result.startsWith('Detected')).reduce((a, e) => a + Number(e.result.match(/Detected (\d+)/)?.[1] ?? 0), 0) },
    { label: 'Evidence queries', value: visible.filter((e) => e.stage === 'evidence').length },
    { label: 'Work created', value: visible.filter((e) => e.stage === 'act' && e.action.startsWith('Created')).length },
    { label: 'Approvals requested', value: visible.filter((e) => e.stage === 'approval').length },
  ];

  const caption = idx < 0
    ? { time: '6:00 PM', text: 'The PM leaves for the day. Your product doesn’t sleep. Neither does Jagr.' }
    : finished
      ? { time: '8:00 AM', text: 'Morning brief ready. Nothing in production was changed without a human.' }
      : { time: fmt12h(clock), text: current?.action ?? '' };

  const skip = () => {
    setIdx(beats.length - 1);
    setFinished(true);
    setPaused(false);
  };

  const dark = mode === 'demo';
  return (
    <div className={cx('fixed inset-0 z-[80] flex flex-col', dark ? 'bg-[#0b0c0f] text-[#ececee]' : 'bg-black/40 p-3 sm:p-8')} role="dialog" aria-modal="true" aria-label="Overnight run replay">
      <div className={cx('flex min-h-0 flex-1 flex-col', !dark && 'mx-auto w-full max-w-4xl overflow-hidden rounded-lg border border-line bg-surface shadow-pop')}>
        {/* Header */}
        <div className={cx('flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6', dark ? 'border-white/10' : 'border-line')}>
          <div className="flex min-w-0 items-center gap-2.5">
            <LogoMark size={20} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{mode === 'demo' ? 'Demo night — scripted replay' : 'Demo night — overnight run'}</div>
              <div className={cx('truncate text-[12px]', dark ? 'text-white/45' : 'text-ink-3')}>
                Demo night · simulated data · replaying {run.events.length} real agent events in compressed time
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <HeaderButton dark={dark} onClick={() => setPaused((p) => !p)} label={paused ? 'Resume' : 'Pause'} icon={paused ? Play : Pause} />
            <HeaderButton dark={dark} onClick={skip} label="Skip to brief" icon={SkipForward} />
            <HeaderButton dark={dark} onClick={onClose} label="Close" icon={X} iconOnly />
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,380px)_1fr]">
          {/* Left: clock + pipeline */}
          <div className={cx('flex flex-col gap-5 border-b p-4 sm:p-6 lg:border-r lg:border-b-0', dark ? 'border-white/10' : 'border-line', !dark && 'max-lg:hidden')}>
            <div>
              <div className={cx('text-[12px] font-semibold uppercase tracking-[0.1em]', dark ? 'text-white/40' : 'text-ink-3')}>Simulated time</div>
              <div className="tabular mt-1 font-mono text-[44px] leading-none font-medium tracking-tight sm:text-[56px]">{fmtTime(clock)}</div>
              <div className={cx('relative mt-4 h-1 rounded-full', dark ? 'bg-white/10' : 'bg-muted')}>
                <div className={cx('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500', dark ? 'bg-white/80' : 'bg-ink')} style={{ width: `${progress * 100}%` }} />
              </div>
              <div className={cx('mt-1.5 flex justify-between text-[12px]', dark ? 'text-white/40' : 'text-ink-3')}>
                <span>18:00</span>
                <span>08:00</span>
              </div>
            </div>
            <ol className="flex flex-col gap-0.5">
              {PIPELINE.map((label, i) => {
                const done = i < reached || finished;
                const active = !finished && i === activeStage;
                return (
                  <li key={label} className={cx('flex items-center gap-2.5 rounded px-2 py-1 text-[13px] transition-colors', active && (dark ? 'bg-white/[0.07]' : 'bg-subtle'))}>
                    <span
                      className={cx(
                        'grid size-4 shrink-0 place-items-center rounded-full border text-[12px]',
                        done ? (dark ? 'border-white/70 bg-white/80 text-black' : 'border-ink bg-ink text-canvas') : active ? (dark ? 'border-white animate-pulse-dot' : 'border-ink animate-pulse-dot') : dark ? 'border-white/20' : 'border-line-strong',
                      )}
                    >
                      {done && <Check size={10} strokeWidth={3} />}
                    </span>
                    <span className={cx(done || active ? '' : dark ? 'text-white/35' : 'text-ink-3')}>{label}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Right: live feed */}
          <div className="flex min-h-0 flex-col">
            <div className={cx('grid grid-cols-3 gap-px border-b sm:grid-cols-5', dark ? 'border-white/10 bg-white/10' : 'border-line bg-line')}>
              {counters.map((c) => (
                <div key={c.label} className={cx('px-4 py-3', dark ? 'bg-[#0b0c0f]' : 'bg-surface', c.label === 'Approvals requested' || c.label === 'Work created' ? 'max-sm:hidden' : '')}>
                  <div className={cx('truncate text-[12px]', dark ? 'text-white/45' : 'text-ink-3')}>{c.label}</div>
                  <div className="tabular text-[20px] font-semibold">{c.value}</div>
                </div>
              ))}
            </div>
            <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
              {visible.length === 0 && (
                <div className={cx('py-10 text-[13px]', dark ? 'text-white/40' : 'text-ink-3')}>Waiting for the first sweep…</div>
              )}
              <ul className="flex flex-col">
                {visible.map((e, i) => (
                  <li key={e.id} className={cx('animate-fade-up grid grid-cols-[62px_86px_1fr] gap-2 border-b py-1.5 text-[13px] max-sm:grid-cols-[54px_1fr]', dark ? 'border-white/[0.06]' : 'border-line', i === visible.length - 1 && !finished && (dark ? 'text-white' : 'text-ink'))}>
                    <span className={cx('tabular font-mono text-[12px]', dark ? 'text-white/45' : 'text-ink-3')}>{fmtTime(e.at, true)}</span>
                    <span className="max-sm:hidden">
                      <StageChip stage={e.stage} status={e.status} dark={dark} />
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{e.action}</span>
                      <span className={cx(dark ? 'text-white/50' : 'text-ink-3')}> — {e.result}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Caption */}
        <div className={cx('flex items-center gap-3 border-t px-4 py-3.5 sm:px-6', dark ? 'border-white/10' : 'border-line')}>
          <span className={cx('tabular shrink-0 font-mono text-[12px]', dark ? 'text-white/50' : 'text-ink-3')}>{caption.time}</span>
          <span key={caption.text} className="animate-fade-up truncate text-[14px] font-medium sm:text-[16px]">{caption.text}</span>
          {finished && (
            <button onClick={() => doneRef.current()} className={cx('ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium', dark ? 'bg-white text-black' : 'bg-ink text-canvas')}>
              Open morning brief
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderButton({ dark, onClick, label, icon: Icon, iconOnly }: { dark: boolean; onClick: () => void; label: string; icon: typeof Play; iconOnly?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cx(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
        dark ? 'text-white/70 hover:bg-white/10 hover:text-white' : 'text-ink-2 hover:bg-subtle hover:text-ink',
      )}
    >
      <Icon size={14} />
      {!iconOnly && <span className="max-sm:hidden">{label}</span>}
    </button>
  );
}

function StageChip({ stage, status, dark }: { stage: AgentStage; status: AgentEvent['status']; dark: boolean }) {
  const warn = status === 'warning' || status === 'blocked';
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center rounded px-1.5 text-[12px] font-medium',
        warn ? (dark ? 'bg-amber-400/15 text-amber-300' : 'bg-high-soft text-high') : dark ? 'bg-white/[0.07] text-white/65' : 'bg-subtle text-ink-2',
      )}
    >
      {STAGE_LABEL[stage] ?? stage}
    </span>
  );
}
