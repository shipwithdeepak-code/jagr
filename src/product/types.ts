/**
 * JAGR product layer — domain model.
 *
 *   Source → Watch → (Scheduler) → Signal → Investigation → Attention → Notification → Brief
 *
 * Kept separate from the demo-night model in src/domain so the original replay keeps working.
 */

export type ISO = string;

// ─────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────

export type ProviderId = 'jira' | 'ga4' | 'app_store' | 'google_play' | 'email';

/**
 * connected      — a real connector with valid credentials (none exist in this build)
 * simulated      — deterministic fixture data, clearly labelled
 * imported       — data the user uploaded (CSV / JSON), labelled USER IMPORT
 * not_configured — nothing connected or imported for this source
 * unavailable    — the provider cannot be reached; Jagr records a gap, never fabricates
 * error          — the provider responded with an error (e.g. expired token)
 */
export type ConnectionState = 'connected' | 'simulated' | 'imported' | 'not_configured' | 'unavailable' | 'error';

export interface SourceConnection {
  provider: ProviderId;
  state: ConnectionState;
  detail: string;
  updatedAt: ISO;
  /** Display name override — imported data renames the channel (e.g. "Customer feedback", not "App Store"). */
  label?: { name: string; short: string };
}

// ─────────────────────────────────────────────────────────────
// Watches
// ─────────────────────────────────────────────────────────────

export type Area = 'checkout' | 'signup' | 'search' | 'stability' | 'general';

/**
 * What a watch looks at, by role — never by vendor.
 *   metric:<key>  a workspace metric (e.g. metric:checkout_conversion), from whichever source serves it
 *   work_items    new bugs / incidents, from every work-item source in the watch
 *   feedback      negative customer feedback, from every feedback source in the watch
 *   changes       releases, deploys and other changes — context for investigations
 */
export type SignalKey = `metric:${string}` | 'work_items' | 'feedback' | 'changes';

export interface WatchSignal {
  key: SignalKey;
  /** For work-item / feedback signals: which product area to look for. '*' = every area. */
  area?: Area | '*';
}

export type MonitoringFrequency = '15m' | '30m' | '1h' | '4h' | 'daily';

export interface WatchSchedule {
  frequency: MonitoringFrequency;
  /** Time of day for `daily` watches (HH:MM, watch timezone). */
  dailyAt: string;
}

export type AttentionLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface NotificationPolicy {
  /** Email when a confirmed investigation reaches this level (CRITICAL always emails immediately). */
  interruptAt: Exclude<AttentionLevel, 'LOW'>;
  /** Include findings at or above this level in the morning brief. */
  briefMin: Exclude<AttentionLevel, 'LOW' | 'CRITICAL'>;
  morningBrief: boolean;
}

export interface Watch {
  id: string;
  name: string;
  description: string;
  template: WatchTemplateId;
  area: Area | '*';
  sources: ProviderId[];
  signals: WatchSignal[];
  schedule: WatchSchedule;
  timezone: string;
  severityThreshold: AttentionLevel;
  /**
   * Optional per-metric detection thresholds, keyed by metric key (e.g. 'checkout_conversion').
   * Same unit as the metric's default: % change for relative metrics, points for absolute ones,
   * always compared against the metric's baseline. Missing = the metric's default threshold.
   */
  thresholds?: Partial<Record<string, number>>;
  notificationPolicy: NotificationPolicy;
  status: 'active' | 'paused';
  createdAt: ISO;
  updatedAt: ISO;
}

export type WatchTemplateId = 'checkout_health' | 'app_stability' | 'conversion' | 'revenue' | 'customer_issues' | 'release_health' | 'signup_funnel' | 'search_discovery';

export interface BriefSchedule {
  enabled: boolean;
  time: string;
  timezone: string;
}

// ─────────────────────────────────────────────────────────────
// Normalised source records
// ─────────────────────────────────────────────────────────────

export type RecordKind = 'metric' | 'issue' | 'release' | 'review';

export interface SourceRef {
  provider: ProviderId;
  kind: RecordKind;
  id: string;
}

export interface SourceLink {
  label: string;
  provider: ProviderId;
  /** In-app route that renders the record. Always resolvable, even for simulated data. */
  href: string;
  /** Where the link points once a real connector is configured. */
  externalUrl: string;
  simulated: boolean;
  ref?: SourceRef;
}

// ─────────────────────────────────────────────────────────────
// Investigations
// ─────────────────────────────────────────────────────────────

export type InvestigationState = 'DETECTED' | 'INVESTIGATING' | 'CONFIRMED' | 'DISMISSED' | 'RESOLVED';

export interface DetectedSignal {
  key: SignalKey;
  provider: ProviderId;
  area: Area;
  label: string;
  /** Human-readable magnitude, e.g. "−18%" or "−0.67 pts" or "4 issues". */
  magnitude: string;
  /** Size of the move relative to the signal's threshold (1 = just at threshold). */
  ratio: number;
  onsetAt: ISO;
  detectedAt: ISO;
  refs: SourceRef[];
}

export type EvidenceDirection = 'degraded' | 'stable' | 'change' | 'gap';

export interface EvidenceItem {
  id: string;
  provider: ProviderId;
  direction: EvidenceDirection;
  /** A factual statement of what the source shows. Never interpretive. */
  statement: string;
  onsetAt?: ISO;
  refs: SourceRef[];
  link?: SourceLink;
  /** For negative findings ("no releases", "no issues"): the tool query that returned nothing. */
  query?: { tool: ToolName; input: string };
}

/**
 * A possible explanation. Deliberately carries no probability: Jagr's confidence number measures
 * whether the problem is real, and must never be read as confidence in a cause.
 */
export interface Hypothesis {
  statement: string;
  basis: 'temporal_correlation' | 'cross_source' | 'single_source' | 'customer_reports' | 'outside_sources';
  role: 'leading' | 'alternative';
}

// ─────────────────────────────────────────────────────────────
// Agent investigation (Phase 2)
// ─────────────────────────────────────────────────────────────

/** The investigator's tools — one per evidence role. Each call names a source id; none names a vendor. */
export type ToolName = 'getMetric' | 'getMetricBreakdown' | 'getChanges' | 'getWorkItems' | 'getFeedback' | 'getFeedbackVolume';

export type HypothesisKind = 'release_related' | 'shared_product_issue' | 'demand_shift' | 'measurement_artifact' | 'external_or_unobserved' | 'customer_only';

/** How much independent evidence lines up with an explanation — explicitly NOT the probability it is the cause. */
export type EvidenceStrength = 'none' | 'weak' | 'moderate' | 'strong';

export interface AgentHypothesis {
  kind: HypothesisKind;
  statement: string;
  status: 'untested' | 'open' | 'supported' | 'contested' | 'ruled_out';
  strength: EvidenceStrength;
  evidenceFor: string[];
  evidenceAgainst: string[];
  unknowns: string[];
}

export type TraceKind = 'signal' | 'plan' | 'hypothesis' | 'gap' | 'planner' | 'tool_call' | 'result' | 'assessment' | 'uncertainty' | 'stop' | 'attention' | 'action' | 'approval' | 'notify' | 'recheck' | 'human';

export interface TraceStep {
  id: string;
  at: ISO;
  pass: number;
  kind: TraceKind;
  title: string;
  detail?: string;
  tool?: ToolName;
  source?: ProviderId;
  input?: string;
  result?: string;
  status?: 'ok' | 'unavailable' | 'error' | 'skipped';
  why?: string;
  changed?: string[];
  refs?: SourceRef[];
  /** Set on `planner` steps: who proposed the next tool and whether policy let it run. */
  planner?: PlannerDecision;
}

/**
 * One planning decision. The model (or the deterministic fallback) only PROPOSES; the policy
 * validator decides whether anything executes. Text fields are concise, auditable summaries the
 * planner was asked to supply — never hidden reasoning.
 */
export interface PlannerDecision {
  /** LLM: an LLM provider proposed it · DETERMINISTIC: no LLM configured · DETERMINISTIC_FALLBACK: the LLM failed or was rejected. */
  type: 'LLM' | 'DETERMINISTIC' | 'DETERMINISTIC_FALLBACK';
  investigationId?: string;
  /** Human-readable planner name, e.g. "Gemini", "Claude", "Scripted test planner — … (not a model)". */
  plannerLabel: string;
  /** Provider id and model as reported by the planner layer. Never credentials. */
  provider?: string;
  model?: string;
  latencyMs?: number;
  /** A configured fallback provider answered because the primary was unavailable. */
  providerFallback?: { from: string; reason: string };
  proposedTool?: string;
  evidenceGap?: string;
  reason?: string;
  hypothesesAffected?: string[];
  expectedEvidence?: string;
  validator: 'APPROVED' | 'REJECTED' | 'NOT_RUN';
  rejection?: { code: string; reason: string };
  /** The model did not produce a usable plan (timeout, malformed output, not configured…). */
  failure?: { code: string; detail: string };
  executedTool?: string;
  resultSummary?: string;
  /** Same investigation state as an earlier decision in this run — the earlier plan was reused. */
  cached?: boolean;
}

export type ActionRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ActionKind = 'link_work_items' | 'create_work_item' | 'create_incident' | 'pause_rollout' | 'rollback_release' | 'notify_customers';

export interface ActionOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Risk-based autonomy:
 * LOW → Jagr does it · MEDIUM → Jagr recommends · HIGH → Jagr prepares it and notifies ·
 * CRITICAL → consequential; nothing happens without human approval.
 * HIGH and CRITICAL actions always go through the approval surface.
 */
export interface ProposedAction {
  id: string;
  investigationId: string;
  kind: ActionKind;
  title: string;
  risk: ActionRisk;
  autonomy: 'autonomous' | 'recommend' | 'prepare_and_notify' | 'approval_required';
  status: 'executed' | 'recommended' | 'awaiting_approval';
  why: string;
  evidence: string[];
  whatWillHappen: string;
  whatCouldGoWrong: string;
  reversible: boolean;
  options?: ActionOption[];
  result?: string;
  proposedAt: ISO;
}

export interface ActionDecision {
  status: 'approved' | 'rejected' | 'done';
  at: ISO;
  optionId?: string;
  note?: string;
  result?: string;
}

export interface InvestigationRun {
  at: ISO;
  watchId: string;
  anomalous: boolean;
  note: string;
}

export interface WatchInvestigation {
  id: string;
  watchId: string;
  watchIds: string[];
  area: Area;
  title: string;
  summary: string;
  startedAt: ISO;
  updatedAt: ISO;
  completedAt?: ISO;
  status: InvestigationState;
  statusHistory: { state: InvestigationState; at: ISO }[];
  attention: AttentionLevel;
  attentionReason: string;
  confidence: number;
  confidenceReason: string;
  signals: DetectedSignal[];
  evidence: EvidenceItem[];
  observed: string[];
  inferred: string[];
  unknowns: string[];
  hypotheses: Hypothesis[];
  likelyExplanation: string;
  uncertainty: string;
  recommendedNextStep: string;
  correlatedProviders: ProviderId[];
  releaseAssociation?: { version: string; releasedAt: ISO; minutesBeforeOnset: number };
  sourceLinks: SourceLink[];
  jagrPath: string;
  jagrLink: string;
  dedupeKey: string;
  runs: InvestigationRun[];
  notifiedLevels: AttentionLevel[];
  /** The agent's step-by-step investigation, across every pass. */
  trace: TraceStep[];
  agentHypotheses: AgentHypothesis[];
  actions: ProposedAction[];
  toolCalls: number;
  stopReason: string;
}

// ─────────────────────────────────────────────────────────────
// Notifications & briefs
// ─────────────────────────────────────────────────────────────

export interface EmailButton {
  label: string;
  href: string;
  kind: 'jagr' | 'source';
  provider?: ProviderId;
  simulated: boolean;
}

export interface EmailNotification {
  id: string;
  kind: 'alert' | 'brief';
  investigationId?: string;
  watchId?: string;
  to: string;
  from: string;
  subject: string;
  sentAt: ISO;
  trigger: 'immediate' | 'confirmed' | 'escalated' | 'scheduled_brief';
  attention?: AttentionLevel;
  sections: {
    whatChanged: string;
    whatJagrFound: string[];
    likelyExplanation: string;
    uncertainty: string;
    recommendedNextStep: string;
  };
  buttons: EmailButton[];
  delivery: 'simulated_outbox';
}

export interface BriefItem {
  investigationId: string;
  attention: AttentionLevel;
  title: string;
  summary: string;
  confidence: number;
  status: InvestigationState;
  emailedAt?: ISO;
  watchNames: string[];
}

export interface MorningBriefDoc {
  id: string;
  generatedAt: ISO;
  window: { start: ISO; end: ISO };
  headline: string;
  items: BriefItem[];
  quiet: { watchCount: number; watchNames: string[]; note: string };
  deduplicated: { watchName: string; linkedTo: string }[];
  stats: { watchRuns: number; sourcesChecked: number; emailsSent: number; dismissed: number };
}

// ─────────────────────────────────────────────────────────────
// Scheduler & run output
// ─────────────────────────────────────────────────────────────

export type JobType = 'watch_run' | 'morning_brief';

export interface ScheduledJob {
  id: string;
  type: JobType;
  at: ISO;
  watchId?: string;
}

export interface SchedulerLogEntry {
  jobId: string;
  type: JobType;
  watchId?: string;
  scheduledAt: ISO;
  outcome: string;
  investigationIds: string[];
  emailIds: string[];
}

/** How tool selection was planned for a monitoring run. */
export interface PlannerRunInfo {
  mode: 'llm' | 'test_double' | 'deterministic';
  /** Where the investigated data came from. The planner never changes this. */
  data?: 'simulated' | 'imported' | 'live' | 'mixed';
  label: string;
  provider?: string;
  model?: string;
  fallback?: { provider: string; label: string; model?: string };
  reason?: string;
}

export interface MonitoringResult {
  window: { start: ISO; end: ISO };
  planner?: PlannerRunInfo;
  investigations: WatchInvestigation[];
  emails: EmailNotification[];
  briefs: MorningBriefDoc[];
  log: SchedulerLogEntry[];
  connections: SourceConnection[];
  actions: ProposedAction[];
}
