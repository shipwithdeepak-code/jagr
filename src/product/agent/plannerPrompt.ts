import type { EvidenceStrength, HypothesisKind, ToolName } from '../types.js';
import { PLANNER_TOOL_NAME } from './plannerSchema.js';
import { redactPersonalData } from '../lib/redact.js';
import type { SourceId } from '../roles/types.js';

/**
 * The investigation state a planner sees, and how it is rendered into a prompt. Provider-neutral:
 * every LLM adapter receives the same system prompt and user prompt; only the transport differs.
 * No path-alias imports: the server-side planner endpoint loads this file too.
 */

export const HYPOTHESIS_ID: Record<HypothesisKind, string> = {
  release_related: 'HYP-01',
  shared_product_issue: 'HYP-02',
  demand_shift: 'HYP-03',
  measurement_artifact: 'HYP-04',
  external_or_unobserved: 'HYP-05',
  customer_only: 'HYP-06',
};

export interface PlannerHypothesis {
  id: string;
  kind: HypothesisKind;
  label: string;
  status: 'untested' | 'open' | 'supported' | 'contested' | 'ruled_out';
  strength: EvidenceStrength;
  ceiling: EvidenceStrength;
  evidenceFor: string[];
  evidenceAgainst: string[];
  unknowns: string[];
}

export interface PlannerOption {
  /** What the planner must put in `nextTool`: the tool name, qualified when the tool has several uses. */
  id: string;
  tool: ToolName;
  /** Opaque source id the call reads from — or the role name, for a call that reads every source of a role. */
  source: SourceId | 'changes';
  /** The source's display name in this workspace (for messages). */
  sourceLabel?: string;
  /** getMetric / getMetricBreakdown: the workspace metric key the call reads. */
  metric?: string;
  sourceState: string;
  /** Hypothesis ids this call can test. */
  tests: string[];
  question: string;
  alreadyQueried: boolean;
  /** The source failed earlier in this pass. */
  sourceFailed: boolean;
  /** Policy view: can the result still move an open explanation below its evidence ceiling? */
  informative: boolean;
  /**
   * Everything this call tests has already been probed twice without any change, while another
   * open explanation has not been tested at all. Policy blocks the repeat until that one is tested.
   */
  probeLimited?: boolean;
}

export interface PlannerInput {
  investigationId: string;
  pass: number;
  signal: { key: string; label: string; magnitude: string };
  area: string;
  budget: { used: number; max: number };
  hypotheses: PlannerHypothesis[];
  evidence: { source: string; direction: string; statement: string }[];
  options: PlannerOption[];
}

export const PLANNER_SYSTEM_PROMPT = `You plan the next step of a product-operations investigation for Jagr.
You receive the signal, the competing hypotheses (with evidence for, against and unknowns), the evidence gathered so far, the tool-call budget and the tool options.
Choose the ONE tool option whose result could most change the investigation — confirm or weaken an open hypothesis, or settle whether the problem is real.
Rules:
- Pick an option id exactly as listed. You cannot call tools yourself, invent tools, take actions (rollbacks, rollout changes, tickets, customer messages) or change the budget.
- Avoid options whose source is unavailable or that were already queried.
- Timing and correlation never establish causation. Do not claim that anything caused anything.
- Jagr's policy rejects any plan text containing causal wording — "caused", "causes", "due to", "because of", "led to", "leads to", "resulted in", "triggered", "root cause" — even inside a question or hypothetical. Use "consistent with", "would support", "would weaken", "tests whether" instead.
- "reason" is a short summary of why this evidence is useful — not step-by-step reasoning.
Respond only with the ${PLANNER_TOOL_NAME} JSON object.`;

export function buildPlannerPrompt(input: PlannerInput): string {
  const h = input.hypotheses
    .map((x) => {
      const bits = [`${x.id} ${x.label} — ${x.status === 'untested' ? 'untested' : x.status === 'ruled_out' ? 'ruled out' : `${x.status}, strength ${x.strength}`} (ceiling ${x.ceiling})`];
      if (x.evidenceFor.length) bits.push(`  for: ${x.evidenceFor.join(' | ')}`);
      if (x.evidenceAgainst.length) bits.push(`  against: ${x.evidenceAgainst.join(' | ')}`);
      if (x.unknowns.length) bits.push(`  unknown: ${x.unknowns.join(' | ')}`);
      return bits.join('\n');
    })
    .join('\n');
  const opts = input.options
    .map((o) => `- ${o.id} — ${o.source} (${o.sourceFailed ? 'failed earlier this pass' : o.sourceState})${o.alreadyQueried ? ' — already queried this pass' : ''} — tests ${o.tests.join(', ') || 'nothing open'} — ${o.question}`)
    .join('\n');
  const ev = input.evidence.map((e) => `- [${e.source}, ${e.direction}] ${e.statement}`).join('\n') || '- none yet';
  // Defence in depth: sources redact customer text when they read it; nothing personal leaves in a prompt either.
  return redactPersonalData(`Signal: ${input.signal.label} ${input.signal.magnitude} (${input.signal.key}), area: ${input.area}. Investigation ${input.investigationId}, pass ${input.pass}.
Tool calls used: ${input.budget.used} of ${input.budget.max}.

Hypotheses:
${h}

Evidence so far:
${ev}

Tool options:
${opts}`);
}

/** Only the parts of the state that should change a plan — so identical states reuse one model call. */
export function planFingerprint(input: PlannerInput): string {
  return JSON.stringify([
    input.signal.key,
    input.area,
    input.budget.used,
    input.hypotheses.map((h) => [h.id, h.status, h.strength]),
    input.options.map((o) => [o.id, o.alreadyQueried, o.sourceFailed, o.sourceState]),
  ]);
}

