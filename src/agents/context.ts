import { AdapterUnavailableError, type AdapterSet } from '@/adapters/types';
import type { AgentEvent, AgentStage, Observation, SourceKind, Team, WorkspaceSettings } from '@/domain/types';
import { addSeconds, isBefore } from '@/lib/time';
import type { ReasoningEngine } from './reasoning';

/** Everything one overnight run needs. Created once per run; the orchestrator threads it through each stage. */
export interface RunContext {
  runId: string;
  settings: WorkspaceSettings;
  teams: Team[];
  adapters: AdapterSet;
  reasoner: ReasoningEngine;
  nightStart: string;
  nightEnd: string;
  clock: SimClock;
  events: AgentEvent[];
  observations: Observation[];
  nextId(prefix: string): string;
  log(e: LogInput): AgentEvent;
  observe(o: Omit<Observation, 'id' | 'observedAt'>): Observation;
}

export type LogInput = Omit<AgentEvent, 'id' | 'seq' | 'runId' | 'at' | 'agent'> & { at?: string };

/** Simulated clock. Tool calls advance it by a deterministic duration so traces have realistic timestamps. */
export class SimClock {
  private t: string;
  constructor(start: string) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  set(t: string) {
    if (isBefore(this.t, t)) this.t = t;
  }
  advance(seconds: number) {
    this.t = addSeconds(this.t, seconds);
  }
}

export function createRunContext(args: {
  runId: string;
  settings: WorkspaceSettings;
  teams: Team[];
  adapters: AdapterSet;
  reasoner: ReasoningEngine;
  nightStart: string;
  nightEnd: string;
}): RunContext {
  const counters = new Map<string, number>();
  const ctx: RunContext = {
    ...args,
    clock: new SimClock(args.nightStart),
    events: [],
    observations: [],
    nextId(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
    log(e) {
      const event: AgentEvent = {
        id: `${args.runId}-evt-${ctx.events.length + 1}`,
        seq: ctx.events.length + 1,
        runId: args.runId,
        at: e.at ?? ctx.clock.now(),
        agent: 'nightwatch',
        ...e,
      };
      ctx.events.push(event);
      return event;
    },
    observe(o) {
      const obs: Observation = { id: ctx.nextId('obs'), observedAt: ctx.clock.now(), ...o };
      ctx.observations.push(obs);
      return obs;
    },
  };
  return ctx;
}

/** Deterministic latency per tool, in seconds — used only to advance the simulated clock. */
export const TOOL_LATENCY: Record<string, number> = {
  'analytics.listMetrics': 2,
  'analytics.getBaseline': 4,
  'analytics.getSeries': 3,
  'analytics.decompose': 11,
  'payments.getProviderBreakdown': 14,
  'payments.getProviderStatus': 3,
  'github.listDeployments': 6,
  'github.getPullRequests': 5,
  'support.searchTickets': 9,
  'experiments.listActiveExperiments': 5,
  'issueTracker.createIssue': 2,
  'issueTracker.findOpenByFingerprint': 1,
  'issueTracker.addComment': 1,
  'notifications.notifyOnCall': 1,
  'reasoner.proposeHypotheses': 4,
};

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string; unavailable: boolean };

/**
 * Run one adapter call with tracing. Adapter failures never crash the run: they are logged,
 * and the caller records the gap as evidence ("GitHub unavailable — release correlation skipped").
 */
export async function callTool<T>(
  ctx: RunContext,
  meta: { tool: string; source: SourceKind; stage: AgentStage; action: string; input?: string; investigationId?: string; routine?: boolean },
  fn: () => Promise<T>,
  describe: (value: T) => string,
): Promise<ToolResult<T>> {
  const latency = TOOL_LATENCY[meta.tool] ?? 2;
  ctx.clock.advance(latency);
  try {
    const value = await fn();
    ctx.log({
      stage: meta.stage,
      action: meta.action,
      tool: meta.tool,
      input: meta.input,
      result: describe(value),
      output: describe(value),
      status: 'ok',
      investigationId: meta.investigationId,
      durationMs: latency * 1000,
      routine: meta.routine,
    });
    return { ok: true, value };
  } catch (err) {
    const unavailable = err instanceof AdapterUnavailableError;
    const message = err instanceof Error ? err.message : String(err);
    ctx.log({
      stage: meta.stage,
      action: meta.action,
      tool: meta.tool,
      input: meta.input,
      result: unavailable ? `Source unavailable — continuing without ${meta.source}` : `Tool failed: ${message}`,
      output: message,
      status: unavailable ? 'warning' : 'error',
      investigationId: meta.investigationId,
      durationMs: latency * 1000,
    });
    return { ok: false, error: message, unavailable };
  }
}
