import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, Eyebrow } from '@/components/ui';

function H({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mt-12 mb-3 scroll-mt-20 text-[20px] font-semibold tracking-[-0.015em]">
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[14px] leading-[1.7] text-ink-2">{children}</p>;
}

function Decision({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-l-2 border-line-strong py-1 pl-4">
      <div className="text-[14px] font-semibold">{title}</div>
      <div className="mt-1 text-[14px] leading-relaxed text-ink-2">{children}</div>
    </div>
  );
}

const TOC = [
  ['what', 'What Jagr is'],
  ['how', 'How it works'],
  ['evidence', 'Evidence, not answers'],
  ['approvals', 'Approvals'],
  ['evaluation', 'Evaluation'],
  ['demo', 'Demo night'],
  ['limitations', 'Limitations'],
];

export function AboutPage() {
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_200px]">
      <article className="max-w-[720px]">
        <Eyebrow>About Jagr</Eyebrow>
        <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.02em] text-balance">Jagr watches your product while you’re away, investigates meaningful changes across your tools, and tells you what needs your attention.</h1>

        <H id="what">What Jagr is</H>
        <P>
          Most product incidents are not outages. They are a release that quietly breaks one payment method, a conversion rate that drifts for no visible reason, a deployment that failed while nobody was looking. Each tool sees its own slice; the PM finds out the next morning and spends the first hours reconstructing what happened.
        </P>
        <P>
          Jagr does that reconstruction on a schedule. You define <strong className="text-ink">watches</strong> — standing questions such as “Is checkout healthy?” or “Did a production deployment fail?” — over the sources you connect. When something meaningful changes, Jagr opens one <strong className="text-ink">investigation</strong>, gathers evidence across your sources, and decides whether it is worth interrupting you.
        </P>
        <P>
          It runs in two ways. A <strong className="text-ink">server workspace</strong> connects live sources (GitHub, Jira, Amplitude, Intercom, with alerts to Slack), stores credentials encrypted on the server, and runs on a schedule without a browser open. A <strong className="text-ink">local workspace</strong> runs in your browser on sample or imported data.
        </P>

        <H id="how">How it works</H>
        <ol className="mb-3 ml-5 list-decimal space-y-1.5 text-[14px] text-ink-2">
          <li><strong className="text-ink">Watch.</strong> Each watch checks its sources on its own schedule; the scheduler also writes the morning brief.</li>
          <li><strong className="text-ink">Detect.</strong> A change must persist and sit well outside its baseline (the same hours on previous nights) — or, for changes, a source must report a failed deployment.</li>
          <li><strong className="text-ink">Investigate.</strong> A planner chooses the next check; a policy validator approves every proposal before a tool runs.</li>
          <li><strong className="text-ink">Correlate.</strong> Signals from different sources that move together become one investigation, not five alerts.</li>
          <li><strong className="text-ink">Decide.</strong> Attention (LOW to CRITICAL) decides who is interrupted: an alert now, the morning brief, or nothing.</li>
          <li><strong className="text-ink">Link.</strong> Every alert and brief links to the investigation, and every fact links to its source record.</li>
        </ol>

        <H id="evidence">Evidence, not answers</H>
        <P>
          Every investigation separates what the sources <strong className="text-ink">observed</strong>, what Jagr <strong className="text-ink">infers</strong> from it, what it <strong className="text-ink">assumes</strong>, and what is <strong className="text-ink">unknown</strong>. Timing is never presented as a cause: “conversion fell 20 minutes after release 4.8.1” is recorded as a timing correlation, and the cause stays “not established” until evidence establishes it. Confidence measures whether the signal is real — never whether an explanation is right.
        </P>

        <H id="approvals">Approvals</H>
        <P>
          Actions are gated by risk. Low-risk, reversible steps (linking an issue) Jagr may take itself; anything that touches production, money or customers — pausing a rollout, a rollback, a customer message — is prepared with its evidence, its effect and what could go wrong, and waits for a person. There is no setting that lets Jagr take those actions on its own.
        </P>

        <H id="evaluation">Evaluation</H>
        <P>
          The <Link to="/evaluations" className="text-accent hover:underline">evaluation suite</Link> replays fixture nights through the real engine and checks behaviour, not wording: does it catch real problems, stay quiet on noise, refuse to invent causes, and respect approval gates? The same suites run in the test suite on every change.
        </P>

        <H id="demo">Demo night: the original agent</H>
        <P>
          Demo night replays the first version of Jagr on a scripted Klarna payment regression. It uses its own engine and simulated adapters, separate from any workspace, and it is kept because its design decisions still shape the product.
        </P>
        <h3 className="mt-6 mb-2 text-[16px] font-semibold">Agent architecture</h3>
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
          None of the answers are stored. The demo scenario contains raw data only: metric series, provider logs with error codes, deploys, PR file lists, tickets and experiment allocations. The Klarna/v4.8.1 conclusion — and its 87% — is derived at runtime. Turn GitHub off in Demo night’s Integrations and the same night produces “Klarna checkout regression (cause not yet identified)” at 72% with no rollback proposed.
        </P>

        <h3 className="mt-6 mb-2 text-[16px] font-semibold">Autonomy model</h3>
        <P>
          Five levels: <strong className="text-ink">Observe</strong>, <strong className="text-ink">Investigate</strong>, <strong className="text-ink">Recommend</strong>, <strong className="text-ink">Execute low-risk</strong> (tasks, incident drafts, on-call notifications, adding evidence to issues) and <strong className="text-ink">Human approval</strong> (production rollback, disabling payment methods, pricing, refunds, customer communication, production config).
        </P>
        <P>
          The PM can dial levels 0–3 down, and choose whether tasks are auto-filed or drafted for review. Level 4 has only two settings: requires approval, or disabled. There is deliberately no setting that lets Jagr roll back production on its own. That is a product decision, not a missing feature.
        </P>

        <h3 className="mt-6 mb-2 text-[16px] font-semibold">Tool architecture</h3>
        <P>
          The agent talks only to typed adapter interfaces — <span className="font-mono text-[13px]">AnalyticsAdapter</span>, <span className="font-mono text-[13px]">PaymentsAdapter</span>, <span className="font-mono text-[13px]">GitHubAdapter</span>, <span className="font-mono text-[13px]">SupportAdapter</span>, <span className="font-mono text-[13px]">ExperimentAdapter</span>, <span className="font-mono text-[13px]">IssueTrackerAdapter</span>, plus notifications. In Demo night every one is a simulation that behaves like the real API: windowed queries, only data that exists “as of” the query time, and failures when unavailable.
        </P>
        <P>
          Replacing a simulation with Amplitude, Stripe, Linear or Zendesk means implementing the same few methods. The orchestrator, evaluations and UI don’t change. Adapter failures are recorded as evidence gaps (“GitHub unavailable — release correlation skipped”) and lower confidence instead of crashing the run.
        </P>

        <h3 className="mt-6 mb-2 text-[16px] font-semibold">Evaluation strategy</h3>
        <P>
          An agent that acts without evaluation isn’t something I’d trust. The <Link to="/evaluations" className="text-accent hover:underline">evaluation suite</Link> replays seven simulated nights through the real orchestrator and checks <em>behaviour</em>: the checkout regression, a normal night (stay quiet), a temporary dip (look, then don’t escalate), a major platform incident (page and request rollback), a missing source (don’t claim what you can’t see), an unexplained decline (say “insufficient evidence”), and a sabotaged planner (the executor must still refuse gated actions).
        </P>
        <P>
          It reports passes, false alerts, missed issues and approval violations — the numbers a PM would put in an agent’s launch review. The same suite runs as unit tests, and it can run against your current settings to show when a policy change breaks expected behaviour.
        </P>

        <h3 className="mt-6 mb-2 text-[16px] font-semibold">Human-in-the-loop design</h3>
        <P>
          Approval requests are designed for a decision, not a notification: the action, its risk and gate, the reason, the evidence and sources, the confidence, the potential impact including side effects (“rollback also reverts two unrelated PRs”), and reversibility. <strong className="text-ink">Request more evidence</strong> makes Jagr run targeted follow-up queries for that specific action and attach them.
        </P>
        <P>
          Guardrails are enforced twice: the policy decides what to request, and the executor independently refuses any level-4 action without an approved record. Every agent step and every human response lands in one audit log with tool, input, output, decision, risk and approval status.
        </P>

        <h3 className="mt-6 mb-2 text-[16px] font-semibold">Key product decisions</h3>
        <div className="space-y-4">
          <Decision title="Findings, not alerts">Clustering related anomalies into one investigation was the single biggest noise reduction. Five red metrics from one broken integration should read as one problem.</Decision>
          <Decision title="Persistence before paging">Jagr waited 30 minutes after the first bad bucket before opening the investigation. Slower by design: a transient dip that pages someone at 2 AM costs trust that’s hard to win back.</Decision>
          <Decision title="Ownership follows the cause, not the symptom">Subscription conversion belongs to Growth, but the task went to Payments Engineering because the leading hypothesis implicates payments.</Decision>
          <Decision title="Say “I don’t know”">The export decline has no explanation in the data, and the product says so plainly. It feels less impressive in a demo, but a confident wrong answer does far more damage.</Decision>
          <Decision title="Draft vs file">Critical findings are filed automatically; lower severities are drafted for the PM. Auto-filing everything turns an agent into a backlog polluter.</Decision>
          <Decision title="The model proposes, the scorer grades">A model-backed reasoner can phrase better hypotheses, but confidence always comes from the deterministic evidence scorer, and outputs citing non-existent evidence are rejected.</Decision>
        </div>

        <H id="limitations">Limitations</H>
        <ul className="mb-3 ml-5 list-disc space-y-1.5 text-[14px] text-ink-2">
          <li>Live connectors exist for GitHub, Jira, Amplitude and Intercom; other sources (app stores, GA4) are available as sample or imported data only.</li>
          <li>Alerts are shown in Jagr and posted to Slack when connected. Email delivery is not built.</li>
          <li>Detection compares against the same hours on previous nights; holidays and launches need explicit handling.</li>
          <li>Jagr does not establish causes. It reports timing and co-movement as correlation, and says what would settle the question.</li>
        </ul>
        <Card className="mt-10">
          <div className="text-[13px] text-ink-2">
            <span className="font-medium text-ink">Built with</span> React 19, TypeScript, Vite, Tailwind CSS v4, Zod and Vitest; a Node API on Vercel functions with Postgres (Neon); a scheduler driven by GitHub Actions. Jagr is an independent portfolio project.
          </div>
        </Card>
      </article>
      <nav className="hidden lg:block" aria-label="On this page">
        <div className="sticky top-20">
          <Eyebrow className="mb-2">On this page</Eyebrow>
          <ol className="space-y-1 text-[13px]">
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
