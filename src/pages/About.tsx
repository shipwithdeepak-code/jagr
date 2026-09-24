import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, Eyebrow } from '@/components/ui';

function H({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mt-12 mb-3 scroll-mt-20 text-[19px] font-semibold tracking-[-0.015em]">
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[14.5px] leading-[1.7] text-ink-2">{children}</p>;
}

function Decision({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-l-2 border-line-strong py-1 pl-4">
      <div className="text-[14px] font-semibold">{title}</div>
      <div className="mt-1 text-[13.5px] leading-relaxed text-ink-2">{children}</div>
    </div>
  );
}

const TOC = [
  ['problem', 'Problem'],
  ['why-ai', 'Why AI'],
  ['thesis', 'Product thesis'],
  ['architecture', 'Agent architecture'],
  ['autonomy', 'Autonomy model'],
  ['tools', 'Tool architecture'],
  ['evaluation', 'Evaluation strategy'],
  ['hitl', 'Human-in-the-loop design'],
  ['decisions', 'Key product decisions'],
  ['limitations', 'Limitations'],
  ['learned', 'What I learned'],
];

export function AboutPage() {
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_200px]">
      <article className="max-w-[720px]">
        <Eyebrow>About this build</Eyebrow>
        <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.025em]">An agent that runs while the team sleeps.</h1>
        <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
          Product Nightwatch is a portfolio build: a working product-operations agent with a real orchestration loop, a real evaluation suite and a simulated enterprise behind typed adapters. These notes explain the product decisions behind it.
        </p>

        <H id="problem">Problem</H>
        <P>
          Most product incidents aren’t outages. They’re a release that quietly breaks one payment method, an experiment ramp that dents activation on one platform, a metric that drifts for no visible reason. Nobody is paged, because each system sees only its slice: analytics sees conversion fall, payments sees one provider erroring, GitHub sees a merge, support sees a few annoyed tickets.
        </P>
        <P>
          The PM finds out the next morning. Then the first two hours go on archaeology: pulling dashboards, cross-checking deploy logs, reading tickets, working out who owns it, and writing a ticket that someone else could act on. That work is valuable but repetitive, and it happens after the damage has run all night.
        </P>

        <H id="why-ai">Why AI</H>
        <P>
          Dashboards and threshold alerts already exist. What they can’t do is the step between “this number moved” and “here’s probably why, here’s who should look, here’s the ticket.” That step means reading heterogeneous sources, forming competing explanations, weighing evidence and writing it up for a human. That’s where language models are strong.
        </P>
        <P>
          It’s also where they’re risky: a fluent explanation isn’t a correct one. So the product splits the job. Detection, evidence collection, confidence scoring and permissions are deterministic and testable. Proposing explanations and writing them up is the part a model can take over — and in this build a deterministic reasoner does it, so the demo is reproducible and needs no API key.
        </P>

        <H id="thesis">Product thesis</H>
        <P>
          <strong className="text-ink">The unit of value is a finished piece of work, not an insight.</strong> A summary saying “conversion is down, possibly Klarna” still leaves the PM with the work. A P1 ticket in the right team’s queue that says what broke, why Nightwatch thinks so, how sure it is and what to check first — plus an incident draft and the risky mitigations queued for approval — is work done.
        </P>
        <P>
          The morning brief is therefore organised as <em>what happened, what I did, what I did not do and why</em>. The last part matters as much as the first: trust comes from seeing the agent’s boundaries.
        </P>

        <H id="architecture">Agent architecture</H>
        <P>
          The core loop is <span className="font-mono text-[13px]">signal → investigation → evidence → hypothesis → decision → action → task</span>, implemented as explicit stages in an orchestrator (<span className="font-mono text-[13px]">src/agents/orchestrator.ts</span>) rather than one prompt.
        </P>
        <ul className="mb-3 ml-5 list-disc space-y-1.5 text-[14px] text-ink-2">
          <li><strong className="text-ink">Detection</strong> sweeps 42 signals every 30 minutes. A signal is anomalous only if it breaches the PM’s threshold, sits ≥3σ from the same hours on the previous 28 nights, <em>and</em> persists for three buckets. One bad bucket puts it on watch; recovery dismisses it.</li>
          <li><strong className="text-ink">Prioritisation</strong> clusters related anomalies through a metric tree (subscription conversion ← checkout completion ← payment failures) and by shared onset, so one incident becomes one investigation, not five pages.</li>
          <li><strong className="text-ink">Investigation playbooks</strong> choose which systems to query based on the surface: a purchase-funnel anomaly decomposes the funnel, compares payment providers and reads error codes; an activation anomaly segments by platform and checks experiments.</li>
          <li><strong className="text-ink">Hypotheses</strong> are instantiated from evidence (a provider outlier suggests both “our regression” and “their outage”), then scored in log-odds with an explicit likelihood table. Each weight points to one piece of evidence and carries a reason.</li>
          <li><strong className="text-ink">Confidence</strong> is a softmax across hypotheses plus a fixed “unexplained” option, so the agent always reserves probability for causes it cannot see. Below 35%, or with support from fewer than two independent sources, the answer is “Insufficient evidence.”</li>
          <li><strong className="text-ink">Decisions</strong> plan candidate actions from the leading hypothesis, classify each one’s risk, and check it against the autonomy policy.</li>
          <li><strong className="text-ink">Pre-brief refresh</strong> re-gathers evidence at 08:00 and updates tickets it already filed — support complaints went from 2 to 7 overnight, and PAY-284 says so.</li>
        </ul>
        <P>
          None of the answers are stored. The demo scenario contains raw data only: metric series, provider logs with error codes, deploys, PR file lists, tickets and experiment allocations. The Klarna/v4.8.1 conclusion — and its 87% — is derived at runtime. Turn GitHub off in Integrations and the same night produces “Klarna checkout regression (cause not yet identified)” at 72% with no rollback proposed.
        </P>

        <H id="autonomy">Autonomy model</H>
        <P>
          Five levels: <strong className="text-ink">Observe</strong>, <strong className="text-ink">Investigate</strong>, <strong className="text-ink">Recommend</strong>, <strong className="text-ink">Execute low-risk</strong> (tasks, incident drafts, on-call notifications, adding evidence to issues) and <strong className="text-ink">Human approval</strong> (production rollback, disabling payment methods, pricing, refunds, customer communication, production config).
        </P>
        <P>
          The PM can dial levels 0–3 down, and choose whether tasks are auto-filed or drafted for review. Level 4 has only two settings: requires approval, or disabled. There is deliberately no setting that lets Nightwatch roll back production on its own. That is a product decision, not a missing feature.
        </P>

        <H id="tools">Tool architecture</H>
        <P>
          The agent talks only to typed adapter interfaces — <span className="font-mono text-[13px]">AnalyticsAdapter</span>, <span className="font-mono text-[13px]">PaymentsAdapter</span>, <span className="font-mono text-[13px]">GitHubAdapter</span>, <span className="font-mono text-[13px]">SupportAdapter</span>, <span className="font-mono text-[13px]">ExperimentAdapter</span>, <span className="font-mono text-[13px]">IssueTrackerAdapter</span>, plus notifications. Every one is currently a simulation that behaves like the real API: windowed queries, only data that exists “as of” the query time, and failures when unavailable.
        </P>
        <P>
          Replacing a simulation with Amplitude, Stripe, Linear or Zendesk means implementing the same few methods. The orchestrator, evaluations and UI don’t change. Adapter failures are recorded as evidence gaps (“GitHub unavailable — release correlation skipped”) and lower confidence instead of crashing the run.
        </P>

        <H id="evaluation">Evaluation strategy</H>
        <P>
          An agent that acts without evaluation isn’t something I’d trust. The <Link to="/evaluations" className="text-accent hover:underline">evaluation suite</Link> replays seven simulated nights through the real orchestrator and checks <em>behaviour</em>: the checkout regression, a normal night (stay quiet), a temporary dip (look, then don’t escalate), a major platform incident (page and request rollback), a missing source (don’t claim what you can’t see), an unexplained decline (say “insufficient evidence”), and a sabotaged planner (the executor must still refuse gated actions).
        </P>
        <P>
          It reports passes, false alerts, missed issues and approval violations — the numbers a PM would put in an agent’s launch review. The same suite runs as unit tests, and it can run against your current settings to show when a policy change breaks expected behaviour.
        </P>

        <H id="hitl">Human-in-the-loop design</H>
        <P>
          Approval requests are designed for a decision, not a notification: the action, its risk and gate, the reason, the evidence and sources, the confidence, the potential impact including side effects (“rollback also reverts two unrelated PRs”), and reversibility. <strong className="text-ink">Request more evidence</strong> makes Nightwatch run targeted follow-up queries for that specific action and attach them.
        </P>
        <P>
          Guardrails are enforced twice: the policy decides what to request, and the executor independently refuses any level-4 action without an approved record. Every agent step and every human response lands in one audit log with tool, input, output, decision, risk and approval status.
        </P>

        <H id="decisions">Key product decisions</H>
        <div className="space-y-4">
          <Decision title="Findings, not alerts">Clustering related anomalies into one investigation was the single biggest noise reduction. Five red metrics from one broken integration should read as one problem.</Decision>
          <Decision title="Persistence before paging">Nightwatch waited 30 minutes after the first bad bucket before opening the investigation. Slower by design: a transient dip that pages someone at 2 AM costs trust that’s hard to win back.</Decision>
          <Decision title="Ownership follows the cause, not the symptom">Subscription conversion belongs to Growth, but the task went to Payments Engineering because the leading hypothesis implicates payments.</Decision>
          <Decision title="Say “I don’t know”">The export decline has no explanation in the data, and the product says so plainly. It feels less impressive in a demo, but a confident wrong answer does far more damage.</Decision>
          <Decision title="Draft vs file">Critical findings are filed automatically; lower severities are drafted for the PM. Auto-filing everything turns an agent into a backlog polluter.</Decision>
          <Decision title="The model proposes, the scorer grades">A model-backed reasoner can phrase better hypotheses, but confidence always comes from the deterministic evidence scorer, and outputs citing non-existent evidence are rejected.</Decision>
        </div>

        <H id="limitations">Limitations</H>
        <ul className="mb-3 ml-5 list-disc space-y-1.5 text-[14px] text-ink-2">
          <li>All integrations are simulated. No external system is connected, and approvals change simulated state only.</li>
          <li>The likelihood weights are hand-set and tuned on a small scenario set. In production they should be calibrated against labelled past incidents, with confidence checked for calibration (are 80% calls right ~80% of the time?).</li>
          <li>Detection uses a same-hour baseline without seasonality beyond that; holidays and launches would need explicit handling.</li>
          <li>Support classification is keyword-based. It’s the most obvious place for a model to replace rules.</li>
          <li>State lives in the browser. A real deployment needs a scheduler, a durable store and auth — intentionally out of scope.</li>
          <li>The overnight run is computed in milliseconds and replayed in compressed time; the replay is real events, but it isn’t a live stream.</li>
        </ul>

        <H id="learned">What I learned</H>
        <P>
          The hard part of an autonomous agent isn’t the reasoning. It’s deciding what it’s allowed to do, how it shows its work, and how you know it’s still behaving after the next change. Most of the product surface here — the brief’s “did not do” list, the evidence graph, the approval card, the evaluation page — is about trust, not intelligence.
        </P>
        <P>
          Second: “insufficient evidence” and “dismissed as transient” turned out to be features. They are what makes the confident calls believable.
        </P>
        <Card className="mt-10">
          <div className="text-[13px] text-ink-2">
            <span className="font-medium text-ink">Stack:</span> React 19, TypeScript, Vite, Tailwind CSS v4, Zod, Vitest. No backend; runs entirely in the browser. Source layout: <span className="font-mono text-[12.5px]">agents/ adapters/ simulation/ domain/ evaluation/ components/ pages/ state/ lib/</span>.
          </div>
        </Card>
      </article>
      <nav className="hidden lg:block" aria-label="On this page">
        <div className="sticky top-20">
          <Eyebrow className="mb-2">On this page</Eyebrow>
          <ol className="space-y-1 text-[12.5px]">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }} className="text-ink-3 hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>
    </div>
  );
}
