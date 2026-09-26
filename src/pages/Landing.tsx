import { ArrowRight, Lock } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { markSigningIn, useServerSession } from '@/state/serverSession';
import { useExploreLocally } from '@/state/exploreLocally';
import { serverApi } from '@/state/serverApi';
import { Logo } from '@/components/Logo';
import { GoogleMark } from '@/components/WorkspaceGate';
import { MetricValue, StatusBadge } from '@/components/primitives';
import { cx } from '@/components/ui';

/**
 * The public landing page — outside the application shell (see state/surface.ts). Outcome first:
 * Jagr watches while you're away → what changed → you don't have to watch everything → what Jagr
 * knows and doesn't → the investigation itself. Every figure on the page is illustrative and says so.
 *
 * Motion: one authored moment — the overnight timeline, played once when it comes into view — plus a
 * quiet watching signal and a live UTC clock in the hero. Content is always present and readable;
 * motion only dims and lights it, so screen readers and reduced motion get the whole story.
 */
export function LandingPage() {
  // The landing is always Jagr's dark world, whatever the app theme (tokens only — see index.css).
  useEffect(() => {
    document.body.classList.add('theme-dark');
    return () => document.body.classList.remove('theme-dark');
  }, []);

  return (
    <div className="theme-dark min-h-dvh bg-canvas text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px]">
        Skip to content
      </a>
      <PublicNav />
      <main id="main" className="mx-auto w-full max-w-[1280px] px-4 sm:px-8 lg:px-16">
        <Hero />
        <WhatChanged />
        <Attention />
        <Knowledge />
        <Investigation />
        <Close />
      </main>
      <footer className="mx-auto mt-24 flex w-full max-w-[1280px] flex-wrap gap-x-6 gap-y-2 border-t border-line px-4 py-6 text-[13px] text-ink-3 sm:px-8 lg:px-16">
        <span>Jagr — product monitoring and investigation</span>
        <Link to="/demo" className="hover:text-ink">
          Demo night
        </Link>
        <Link to="/about" className="hover:text-ink">
          About
        </Link>
        <span className="sm:ml-auto">Figures on this page are illustrative.</span>
      </footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Entry points — the existing sign-in and workspace flows, never a new one
// ─────────────────────────────────────────────────────────────

const btn = 'interactive inline-flex h-11 items-center gap-2 rounded-lg px-4 text-[14px] font-medium whitespace-nowrap';
const btnPrimary = cx(btn, 'bg-ink text-canvas hover:opacity-90');
const btnSecondary = cx(btn, 'border border-line-strong text-ink hover:border-ink-3');

/**
 * The server entry, in the state the session is in. The landing shows to a signed-in person only after
 * they chose to leave their workspace, so this is their way back:
 *   checking            a quiet placeholder — never a disabled sign-in button that may not apply
 *   signed out          Continue with Google (the existing flow; the return opens their workspace)
 *   one workspace       Open <name>
 *   several / none      Choose workspace / Create your workspace (the workspace gate)
 *   no Jagr server      nothing to offer, so nothing is shown
 */
function ServerEntry({ compact = false }: { compact?: boolean }) {
  const session = useServerSession();
  const size = compact && 'h-9 px-3 text-[13px]';
  if (!session.checked) {
    return (
      <span className={cx('inline-block shrink-0 rounded-lg bg-subtle', compact ? 'h-9 w-20' : 'h-11 w-[196px]')} aria-hidden="true" />
    );
  }
  if (session.user) {
    const only = session.workspaces.length === 1 ? session.workspaces[0] : undefined;
    return only ? (
      <button type="button" className={cx(btnPrimary, size, compact && 'max-w-[40vw]')} onClick={() => session.open(only.id)}>
        <span className="truncate">Open {only.name}</span>
      </button>
    ) : (
      <button type="button" className={cx(btnPrimary, size)} onClick={session.clearChoice}>
        {session.workspaces.length ? 'Choose workspace' : 'Create your workspace'}
      </button>
    );
  }
  if (!session.server?.signIn.includes('google')) return null;
  return (
    <a href={serverApi.signInUrl('google', '/')} onClick={markSigningIn} className={cx(btnPrimary, size)}>
      {!compact && <GoogleMark />}
      {compact ? 'Sign in' : 'Continue with Google'}
    </a>
  );
}

function Entry() {
  // Reopens this browser's workspace if it exists (imports intact); creates it only when there is none.
  const explore = useExploreLocally();
  const quiet = 'interactive underline-offset-4 hover:text-ink hover:underline';
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ServerEntry />
        <button type="button" className={btnSecondary} onClick={() => explore('sample')}>
          Explore locally
        </button>
        <Link to="/demo" className="interactive inline-flex items-center gap-1 text-[14px] whitespace-nowrap text-ink-2 hover:text-ink">
          Watch Demo night <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-3">
        <button
          type="button"
          className={quiet}
          onClick={() => explore('imported')}
        >
          Explore locally with your own data
        </button>
      </p>
    </div>
  );
}

function PublicNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas">
      <nav aria-label="Primary" className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-6 px-4 sm:px-8 lg:px-16">
        <a href="#top" aria-label="Jagr, back to top">
          <Logo />
        </a>
        <div className="ml-auto flex items-center gap-6 text-[14px] text-ink-2">
          <a href="#changes" className="hidden hover:text-ink md:inline">
            What changed
          </a>
          <a href="#trust" className="hidden hover:text-ink md:inline">
            Trust
          </a>
          <a href="#investigation" className="hidden hover:text-ink md:inline">
            Investigation
          </a>
          <Link to="/demo" className="hidden hover:text-ink sm:inline">
            Demo night
          </Link>
          <ServerEntry compact />
        </div>
      </nav>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────
// Hero — the manifesto
// ─────────────────────────────────────────────────────────────

function useUtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return { text: `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`, secondFraction: now.getUTCSeconds() / 60 };
}

function Hero() {
  const clock = useUtcClock();
  return (
    <section id="top" aria-labelledby="hero-h" className="grid scroll-mt-20 gap-16 pt-20 pb-20 sm:pt-28 lg:gap-24 lg:pt-32">
      <h1 id="hero-h" className="text-[clamp(2.75rem,9vw,8.5rem)] leading-[0.9] font-semibold tracking-[-0.04em] uppercase [overflow-wrap:anywhere]">
        <span className="block">Your product</span>{' '}
        <span className="block">doesn’t stop.</span>{' '}
        <span className="mt-[0.34em] flex items-center gap-[0.18em] text-ink-3">
          Jagr watches<span className="sr-only">.</span>
          <span className="relative inline-block size-[0.12em] shrink-0 translate-y-[0.18em] rounded-full bg-accent" aria-hidden="true">
            <span className="signal-ping absolute inset-0 rounded-full border border-accent" />
          </span>
        </span>
      </h1>
      <div className="grid gap-10 border-t border-line pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,540px)] lg:items-end">
        <div className="order-2 grid gap-2.5 font-mono text-[13px] text-ink-3 lg:order-none">
          <p>
            <span className="num text-ink-2">{clock.text} UTC</span> · example workspace
          </p>
          <p>6 watches · nothing needs your attention</p>
          <span aria-hidden="true" className="relative h-px max-w-[360px] overflow-hidden bg-line">
            <span className="absolute inset-0 origin-left bg-accent/80 motion-reduce:hidden" style={{ transform: `scaleX(${clock.secondFraction})` }} />
          </span>
        </div>
        <div className="grid gap-7">
          <p className="max-w-[60ch] text-[18px] leading-relaxed text-ink-2">
            Your product changes while you’re in meetings, sleeping, or planning what’s next.{' '}
            <span className="text-ink">Jagr watches the signals, investigates meaningful changes, and brings you what deserves your attention — with the evidence, and with what it does not know.</span>
          </p>
          <Entry />
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared: section heading, reduced motion, first sight of a section
// ─────────────────────────────────────────────────────────────

function Headline({ id, lead, rest }: { id: string; lead: string; rest: string }) {
  return (
    <h2 id={id} className="text-[clamp(2.25rem,6vw,5.25rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance uppercase [overflow-wrap:anywhere]">
      {lead}{' '}
      <br />
      <span className="text-ink-3">{rest}</span>
    </h2>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Calls `onSeen` once, the first time the element is substantially in view. */
function useFirstSight<T extends Element>(onSeen: () => void, threshold = 0.3) {
  const ref = useRef<T>(null);
  const cb = useRef(onSeen);
  cb.current = onSeen;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          cb.current();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

// ─────────────────────────────────────────────────────────────
// Know what changed while you were away — the authored moment
// ─────────────────────────────────────────────────────────────

const NIGHT = [
  { at: '22:14', source: 'GitHub', what: 'Deployment shipped to Production' },
  { at: '22:19', source: 'Amplitude', what: 'Checkout conversion starts to fall' },
  { at: '22:23', source: 'Jira', what: '3 related checkout issues opened' },
  { at: '22:31', source: 'App reviews', what: 'Complaints about paying rise' },
];
/** The sequence: four events arrive, the signal degrades, Jagr investigates, the finding resolves. */
const STEPS = { degrade: 4, investigate: 5, finding: 6 } as const;
const LAST_STEP = STEPS.finding;

function WhatChanged() {
  const reduced = useReducedMotion();
  // -1: waiting to be seen (dimmed, still readable) · 0…6: playing · LAST_STEP: at rest.
  const [step, setStep] = useState(reduced ? LAST_STEP : -1);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const play = () => {
    clearInterval(timer.current);
    if (reduced) return setStep(LAST_STEP);
    setStep(0);
    timer.current = setInterval(() => setStep((s) => (s >= LAST_STEP ? (clearInterval(timer.current), s) : s + 1)), 650);
  };
  useEffect(() => () => clearInterval(timer.current), []);
  useEffect(() => {
    if (reduced) setStep(LAST_STEP);
  }, [reduced]);
  const ref = useFirstSight<HTMLDivElement>(play, 0.35);
  const lit = (i: number) => step >= i;
  const progress = step < 0 ? 0 : Math.min(1, (step + 1) / (STEPS.investigate + 1));

  return (
    <section id="changes" aria-labelledby="changes-h" className="scroll-mt-20 pt-24 sm:pt-36">
      <Headline id="changes-h" lead="Know what changed" rest="while you were away." />
      <p className="mt-6 max-w-[48ch] text-[18px] text-ink-2">Your product keeps moving while you’re not looking. Here is one night, as Jagr saw it.</p>
      <div ref={ref} className="mt-12 grid items-start gap-12 lg:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:gap-20">
        <div>
          <div className="relative">
            <span aria-hidden="true" className="absolute top-3 bottom-3 left-[6px] w-px bg-line-strong" />
            <span aria-hidden="true" className="absolute top-3 bottom-3 left-[6px] w-px origin-top bg-ink-3 transition-transform duration-500 ease-out" style={{ transform: `scaleY(${progress})` }} />
            <ol aria-label="An illustrative night, in order" className="relative">
              {NIGHT.map((e, i) => (
                <li key={e.at} className="grid grid-cols-[14px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 border-b border-line py-4 sm:grid-cols-[14px_56px_104px_minmax(0,1fr)]">
                  <span aria-hidden="true" className={cx('size-[13px] self-center rounded-full border transition-colors duration-500', lit(i) ? 'border-ink bg-ink' : 'border-ink-3 bg-canvas')} />
                  <time className="num font-mono text-[14px] text-ink-3">{e.at}</time>
                  <span className="col-start-2 text-[14px] text-ink-2 sm:col-start-auto">{e.source}</span>
                  <span className={cx('col-start-2 text-[17px] tracking-[-0.01em] transition-colors duration-500 sm:col-start-auto sm:text-[19px]', lit(i) ? 'text-ink' : 'text-ink-3')}>
                    {e.what}
                    {i === 1 && (
                      <span className={cx('ml-2 text-[14px] font-medium transition-opacity duration-500', lit(STEPS.degrade) ? 'text-high opacity-100' : 'opacity-0')}>
                        <span className="sr-only">, falling </span>−18%
                      </span>
                    )}
                  </span>
                </li>
              ))}
              <li className="grid grid-cols-[14px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 py-4 sm:grid-cols-[14px_56px_104px_minmax(0,1fr)]">
                <span aria-hidden="true" className={cx('size-[13px] self-center rounded-full border transition-colors duration-500', lit(STEPS.investigate) ? 'border-accent bg-accent' : 'border-ink-3 bg-canvas')} />
                <time className="num font-mono text-[14px] text-ink-3">22:42</time>
                <span className="col-start-2 text-[14px] font-medium text-accent sm:col-start-auto">Jagr</span>
                <span className={cx('col-start-2 text-[17px] font-medium tracking-[-0.01em] transition-colors duration-500 sm:col-start-auto sm:text-[19px]', lit(STEPS.investigate) ? 'text-ink' : 'text-ink-3')}>
                  Investigates across all four
                </span>
              </li>
            </ol>
          </div>
          <p className="mt-4 text-[13px] text-ink-3">
            An illustrative night.{' '}
            <button type="button" onClick={play} className="interactive underline underline-offset-4 hover:text-ink">
              Replay
            </button>
          </p>
        </div>
        <aside aria-label="What you see in the morning" className={cx(
            // Text is always full contrast; only the decorative rule and a slight settle mark "not yet".
            'grid gap-4 border-t pt-6 transition-[border-color,translate] duration-700 motion-reduce:transition-none lg:sticky lg:top-24',
            lit(STEPS.finding) ? 'translate-y-0 border-ink-3' : 'translate-y-2 border-line-strong motion-reduce:translate-y-0',
          )}>
          <p className="text-[15px] text-ink-2">One thing needs your attention.</p>
          <StatusBadge kind="attention" value="HIGH" size="md" className="justify-self-start" />
          <p className="text-[clamp(1.625rem,3vw,2.25rem)] leading-[1.08] font-semibold tracking-[-0.025em]">Checkout conversion dropped 18%.</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-[15px]">
            <dt className="text-ink-3">Evidence</dt>
            <dd>Amplitude, GitHub, Jira and app reviews — connected</dd>
            <dt className="text-ink-3">Cause</dt>
            <dd className="text-ink-2">Not established</dd>
          </dl>
          <a href="#investigation" className="interactive inline-flex w-fit items-center gap-1 text-[15px] font-medium text-accent hover:underline">
            See the investigation <ArrowRight size={14} aria-hidden />
          </a>
        </aside>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// You shouldn't have to watch everything — where changes land
// ─────────────────────────────────────────────────────────────

type Lands = 'quiet' | 'investigate' | 'high';
const CHANGES: { change: string; why: string; lands: Lands; label: string }[] = [
  { change: 'A 2% conversion dip', why: 'Inside normal variation', lands: 'quiet', label: 'Quiet — noted in the brief' },
  { change: 'An 18% conversion drop', why: 'Persists for most of an hour', lands: 'investigate', label: 'Investigate' },
  { change: 'A crash spike after a deployment', why: 'Two sources move together', lands: 'investigate', label: 'Investigate' },
  { change: 'Several systems degrading', why: 'A core flow, corroborated across sources', lands: 'high', label: 'High attention' },
  { change: 'Nothing meaningful changed', why: 'Every signal inside its normal range', lands: 'quiet', label: 'Stays quiet' },
];
const LAND_COL: Record<Lands, string> = { quiet: 'sm:col-start-1', investigate: 'sm:col-start-2', high: 'sm:col-start-3' };

function Attention() {
  return (
    <section id="attention" aria-labelledby="attention-h" className="scroll-mt-20 pt-24 sm:pt-36">
      <Headline id="attention-h" lead="You shouldn’t have" rest="to watch everything." />
      <p className="mt-6 max-w-[52ch] text-[18px] text-ink-2">Most changes are noise. Jagr sorts them before they reach you — and only a change that matters becomes an interruption.</p>
      <div className="mt-12 lg:mt-16" role="table" aria-label="Where illustrative changes land">
        <div role="row" className="hidden grid-cols-[minmax(0,320px)_minmax(0,1fr)] gap-8 border-b border-line-strong pb-3 text-[13px] text-ink-3 sm:grid">
          <span role="columnheader">Change</span>
          <span role="columnheader" className="grid grid-cols-3">
            <span>Quiet</span>
            <span className="border-l border-line-strong pl-3">Investigate</span>
            <span className="border-l border-line-strong pl-3 text-high">High attention</span>
          </span>
        </div>
        {CHANGES.map((c) => (
          <div role="row" key={c.change} className="grid gap-3 border-b border-line py-5 sm:grid-cols-[minmax(0,320px)_minmax(0,1fr)] sm:items-center sm:gap-8">
            <span role="cell" className="text-[17px] tracking-[-0.01em]">
              {c.change}
              <span className="block text-[14px] tracking-normal text-ink-3">{c.why}</span>
            </span>
            <span role="cell" className="grid grid-cols-1 sm:grid-cols-3">
              <span className={cx('flex items-center gap-2.5 text-[14px] font-medium sm:pl-3', LAND_COL[c.lands], c.lands !== 'quiet' && 'sm:border-l sm:border-line-strong', c.lands === 'high' ? 'text-high' : c.lands === 'investigate' ? 'text-ink' : 'text-ink-2')}>
                <span aria-hidden="true" className={cx('size-3 shrink-0 rounded-full', c.lands === 'high' ? 'bg-high' : c.lands === 'investigate' ? 'bg-ink' : 'border border-ink-3')} />
                {c.label}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Know what Jagr knows. And what it doesn't.
// ─────────────────────────────────────────────────────────────

const KINDS: { kind: string; marker: string; statement: string; note: string; tone: string }[] = [
  { kind: 'Observed', marker: 'bg-ink', statement: 'Conversion fell from 3.40% to 2.79%.', note: 'What a connected source recorded — named, timed, and linked to the record.', tone: 'text-ink' },
  { kind: 'Inferred', marker: 'border-2 border-dashed border-ink-2', statement: 'The drop began shortly after a deployment.', note: 'Jagr’s reading of the facts. A timing correlation — not a cause.', tone: 'text-ink-2' },
  { kind: 'Unknown', marker: 'border border-ink-3', statement: 'The cause has not been established.', note: 'Said plainly, with what would settle it — never filled in with a guess.', tone: 'text-ink-2' },
];

function Knowledge() {
  return (
    <section id="trust" aria-labelledby="trust-h" className="scroll-mt-20 pt-24 sm:pt-36">
      <Headline id="trust-h" lead="Know what Jagr knows." rest="And what it doesn’t." />
      <dl className="mt-12 border-t border-line-strong lg:mt-16">
        {KINDS.map((k) => (
          <div key={k.kind} className="grid gap-3 border-b border-line py-7 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)] sm:gap-8 sm:py-9">
            <dt className="flex items-center gap-3 font-mono text-[14px] tracking-[0.08em] text-ink-2 uppercase">
              <span aria-hidden="true" className={cx('size-3 shrink-0 rounded-full', k.marker)} />
              {k.kind}
            </dt>
            <dd className={cx('text-[clamp(1.375rem,3vw,2.5rem)] leading-[1.15] tracking-[-0.025em]', k.tone)}>
              {k.statement}
              <span className="mt-2.5 block text-[15px] leading-normal tracking-normal text-ink-3">{k.note}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-10 max-w-[40ch] text-[clamp(1.25rem,2.4vw,1.75rem)] leading-snug tracking-[-0.015em] text-ink">Jagr doesn’t turn correlation into certainty.</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Not another dashboard. An investigation.
// ─────────────────────────────────────────────────────────────

const READING = ['Signal', 'Evidence', 'Explanations', 'Unknown', 'What to do'];

function Part({ on, label, children }: { on: boolean; label: string; children: ReactNode }) {
  return (
    <div className={cx('grid gap-3 border-b border-line px-5 py-5 transition-colors duration-500 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-6 sm:px-8', on && 'bg-subtle')}>
      <h4 className="text-[14px] font-medium text-ink-3">{label}</h4>
      <div className="min-w-0 text-[15px] sm:text-[16px]">{children}</div>
    </div>
  );
}

function Investigation() {
  const reduced = useReducedMotion();
  const [at, setAt] = useState(-1);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);
  // One quiet pass through the reading order, then everything rests at equal weight.
  const ref = useFirstSight<HTMLDivElement>(() => {
    if (reduced) return;
    let i = 0;
    setAt(0);
    timer.current = setInterval(() => {
      i += 1;
      if (i >= READING.length) {
        clearInterval(timer.current);
        setAt(-1);
      } else setAt(i);
    }, 1500);
  }, 0.3);

  return (
    <section id="investigation" aria-labelledby="investigation-h" className="scroll-mt-20 pt-24 sm:pt-36">
      <Headline id="investigation-h" lead="Not another dashboard." rest="An investigation." />
      <div ref={ref} className="mt-12 grid items-start gap-10 lg:mt-16 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16">
        <ol aria-label="How an investigation reads" className="flex flex-wrap gap-x-6 gap-y-2 lg:sticky lg:top-24 lg:grid lg:gap-1">
          {READING.map((r, i) => (
            <li key={r} className={cx('flex items-center gap-3 py-1 text-[15px] transition-colors duration-300', at === i ? 'text-ink' : 'text-ink-3')}>
              <span aria-hidden="true" className={cx('h-px transition-all duration-500', at === i ? 'w-8 bg-accent' : 'w-5 bg-line-strong')} />
              {r}
            </li>
          ))}
        </ol>
        <article aria-label="An illustrative investigation" className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className={cx('relative grid gap-3.5 border-b border-line px-5 py-7 transition-colors duration-500 sm:px-8', at === 0 && 'bg-subtle')}>
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-high" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px]">
              <StatusBadge kind="attention" value="HIGH" size="md" />
              <span className="font-medium">Signal confirmed</span>
              <span className="text-ink-2">Cause not established</span>
            </div>
            <h3 className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.05] font-semibold tracking-[-0.03em]">Checkout conversion dropped 18%</h3>
            <MetricValue baseline="3.40%" current="2.79%" change="−18% vs the same hours, previous 28 nights" size="lg" />
            <p className="num flex flex-wrap gap-x-6 gap-y-1 text-[14px] text-ink-3">
              <span>
                Began <b className="font-medium text-ink">22:19 UTC</b>
              </span>
              <span>
                Detected <b className="font-medium text-ink">22:42 UTC</b>
              </span>
              <span>
                As of <b className="font-medium text-ink">23:05 UTC</b>
              </span>
            </p>
          </div>
          <Part on={at === 1} label="Evidence">
            <ul className="grid gap-2.5">
              <li>
                Checkout conversion 2.79% vs 3.40% baseline <span className="text-ink-3">· Amplitude</span>
              </li>
              <li>
                Deployment to Production at 22:14 <span className="text-ink-3">· GitHub</span>
              </li>
              <li>
                3 new checkout issues since 22:23 <span className="text-ink-3">· Jira</span>
              </li>
            </ul>
          </Part>
          <Part on={at === 2} label="Possible explanations">
            <ul className="grid gap-2.5">
              <li className="flex flex-wrap justify-between gap-x-4">
                A real checkout problem affecting users <span className="text-[14px] text-ink-3">Strong · 4 for</span>
              </li>
              <li className="flex flex-wrap justify-between gap-x-4">
                Related to the 22:14 deployment <span className="text-[14px] text-ink-3">Moderate · timing only</span>
              </li>
              <li className="flex flex-wrap justify-between gap-x-4 text-ink-2">
                A tracking change, not real behaviour <span className="text-[14px] text-ink-3">Ruled out</span>
              </li>
            </ul>
          </Part>
          <Part on={at === 3} label="Unknown">
            <p className="text-ink-2 italic">Whether the deployment is responsible. Payment-provider data is not connected.</p>
          </Part>
          <Part on={at === 4} label="What to do">
            <p className="text-[17px] font-medium">Review checkout errors from the 22:14 deployment and triage the three Jira issues.</p>
            <p className="mt-3 flex items-start gap-1.5 text-[14px] text-ink-3">
              <Lock size={13} aria-hidden className="mt-0.5 shrink-0" />
              Pausing the rollout is prepared with its evidence and waits for a person’s approval.
            </p>
          </Part>
        </article>
      </div>
      <p className="mt-4 text-[13px] text-ink-3">An illustrative investigation, in the same form Jagr uses for real ones.</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Close
// ─────────────────────────────────────────────────────────────

function Close() {
  return (
    <section aria-labelledby="close-h" className="mt-32 grid gap-8 border-t border-line pt-16 sm:mt-44 sm:pt-20">
      <Headline id="close-h" lead="Leave it running" rest="tonight." />
      <p className="max-w-[36ch] text-[clamp(1.125rem,2vw,1.5rem)] text-ink-2">Wake up to what changed. Not everything that happened.</p>
      <Entry />
    </section>
  );
}
