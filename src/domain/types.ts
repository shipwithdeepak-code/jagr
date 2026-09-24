/**
 * Product Nightwatch — domain model.
 *
 * The chain every finding follows:
 *   Signal → Observation → Evidence → Investigation → Hypothesis → Decision → Action → Task → Outcome
 *
 * Everything here is plain data so runs can be persisted, replayed, diffed and evaluated.
 */

export type ISODateTime = string;

// ─────────────────────────────────────────────────────────────
// Taxonomy
// ─────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'normal';
export type AlertSeverity = Exclude<Severity, 'normal'>;

export type SignalCategory =
  | 'activation'
  | 'conversion'
  | 'retention'
  | 'revenue'
  | 'payments'
  | 'support'
  | 'engagement'
  | 'reliability';

/** What the PM can switch on/off in "What Nightwatch watches". */
export type WatchArea =
  | 'activation'
  | 'conversion'
  | 'retention'
  | 'revenue'
  | 'payment_failures'
  | 'support_volume'
  | 'engagement'
  | 'reliability'
  | 'releases'
  | 'experiments';

/** Ownership areas used to route work. */
export type ProductArea = 'payments' | 'growth' | 'activation' | 'support' | 'platform' | 'engagement';

export type SourceKind = 'analytics' | 'payments' | 'github' | 'support' | 'experiments' | 'issue_tracker' | 'notifications';

export type MetricUnit = 'percent' | 'count' | 'currency' | 'ms' | 'minutes' | 'score';

export interface MetricDefinition {
  id: string;
  name: string;
  description: string;
  category: SignalCategory;
  unit: MetricUnit;
  /** Which direction is bad. Only moves in the bad direction are alerting anomalies. */
  badDirection: 'down' | 'up';
  /** 1 = business outcome, 2 = key driver, 3 = supporting metric. */
  tier: 1 | 2 | 3;
  area: ProductArea;
  /** Metric tree: which metrics drive this one. Used for decomposition and anomaly clustering. */
  drivers?: string[];
  /** Product surface — used to find relevant experiments, releases and tickets. */
  surface?: 'checkout' | 'onboarding' | 'core' | 'reports' | 'platform' | 'support' | 'billing';
  platform?: 'ios' | 'android' | 'web';
}

// ─────────────────────────────────────────────────────────────
// Signals & observations
// ─────────────────────────────────────────────────────────────

export interface SeriesPoint {
  t: ISODateTime;
  value: number;
}

export interface MetricBaseline {
  mean: number;
  stdDev: number;
  /** Human description of the window, e.g. "Same hours, previous 28 nights". */
  window: string;
  samples: number;
}

export type SignalStatus = 'normal' | 'watching' | 'anomalous' | 'transient';

export interface Signal {
  id: string;
  metricId: string;
  name: string;
  category: SignalCategory;
  unit: MetricUnit;
  badDirection: 'down' | 'up';
  tier: 1 | 2 | 3;
  area: ProductArea;
  current: number;
  baseline: MetricBaseline;
  changePct: number;
  zScore: number;
  severity: Severity;
  status: SignalStatus;
  observedAt: ISODateTime;
  /** First bucket where the deviation began (only for anomalies / transients). */
  onsetAt?: ISODateTime;
  series: SeriesPoint[];
  thresholdPct: number;
  watched: boolean;
  note?: string;
}

/** A raw fact returned by an adapter. Evidence always cites one or more observations. */
export interface Observation {
  id: string;
  source: SourceKind;
  tool: string;
  observedAt: ISODateTime;
  summary: string;
  data: Record<string, string | number | boolean | null | string[]>;
}

// ─────────────────────────────────────────────────────────────
// Evidence & hypotheses
// ─────────────────────────────────────────────────────────────

export type EvidenceKind =
  | 'anomaly'
  | 'driver_moved'
  | 'driver_stable'
  | 'traffic_stable'
  | 'traffic_drop'
  | 'segment_concentrated'
  | 'segment_spread'
  | 'provider_outlier'
  | 'provider_normal'
  | 'provider_error_signature'
  | 'provider_status'
  | 'deployment'
  | 'merged_pr'
  | 'no_recent_deployment'
  | 'support_cluster'
  | 'no_support_signal'
  | 'experiment_change'
  | 'experiment_result'
  | 'experiment_stable'
  | 'reliability_spike'
  | 'recovered'
  | 'source_unavailable';

export type EvidenceStance = 'supports' | 'contradicts' | 'context' | 'gap';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: SourceKind;
  title: string;
  detail: string;
  /** Short headline value for cards, e.g. "-14%" or "+31 pts". */
  value?: string;
  /** How strong the observation is, 0–1, derived from the data (magnitude, count, proximity). */
  strength: number;
  /** Entities the evidence is about — used for correlation (e.g. "klarna", "payments", "v4.8.1"). */
  entities: string[];
  observationIds: string[];
  observedAt: ISODateTime;
  /** Overall stance relative to the leading hypothesis (filled in after scoring). */
  stance: EvidenceStance;
}

export type HypothesisType =
  | 'provider_regression'
  | 'provider_outage'
  | 'release_regression'
  | 'demand_shift'
  | 'experiment_effect'
  | 'instrumentation'
  | 'unexplained';

export interface EvidenceWeight {
  evidenceId: string;
  weight: number;
  reason: string;
}

export interface Hypothesis {
  id: string;
  type: HypothesisType;
  statement: string;
  /** Component implicated — drives ownership of any work created. */
  area: ProductArea;
  entities: string[];
  prior: number;
  weights: EvidenceWeight[];
  /** Log-odds score (prior + Σ weights). */
  score: number;
  /** Normalised posterior probability across all hypotheses including "unexplained". */
  confidence: number;
  status: 'leading' | 'alternative' | 'ruled_out';
  proposedBy: 'deterministic' | 'model';
}

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'insufficient';

// ─────────────────────────────────────────────────────────────
// Investigation
// ─────────────────────────────────────────────────────────────

export type InvestigationStatus = 'investigating' | 'concluded' | 'low_confidence' | 'insufficient_evidence' | 'dismissed';

export type EscalationRoute = 'immediate' | 'morning_brief' | 'daily_digest' | 'none';

export interface ImpactMetric {
  label: string;
  value: string;
  detail?: string;
}

export interface TimelineEntry {
  at: ISODateTime;
  label: string;
  kind: 'release' | 'pr' | 'metric' | 'support' | 'experiment' | 'agent' | 'provider';
  source: SourceKind | 'nightwatch';
}

export interface ReleaseRef {
  version: string;
  deployedAt: ISODateTime;
  services: string[];
  pullRequests: { number: number; title: string; author: string; mergedAt: ISODateTime; files: string[]; relevant: boolean }[];
}

export interface TicketRef {
  id: string;
  createdAt: ISODateTime;
  subject: string;
  channel: string;
  plan: string;
  mentions: string[];
}

export interface Investigation {
  id: string;
  runId: string;
  title: string;
  primarySignalId: string;
  signalIds: string[];
  severity: Severity;
  status: InvestigationStatus;
  playbook: 'purchase_funnel' | 'activation' | 'generic' | 'transient_check';
  startedAt: ISODateTime;
  concludedAt?: ISODateTime;
  /** Time from opening the investigation to its first conclusion. */
  durationSeconds?: number;
  onsetAt?: ISODateTime;
  problem: string;
  impact: ImpactMetric[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  leadingHypothesisId?: string;
  confidence?: number;
  confidenceBand: ConfidenceBand;
  conclusion: string;
  reasoning: string[];
  timeline: TimelineEntry[];
  actionIds: string[];
  taskIds: string[];
  approvalIds: string[];
  relatedReleaseIds: string[];
  relatedTicketIds: string[];
  releases: ReleaseRef[];
  tickets: TicketRef[];
  sourcesQueried: SourceKind[];
  sourcesUnavailable: SourceKind[];
  escalation: EscalationRoute;
  fingerprint: string;
}

// ─────────────────────────────────────────────────────────────
// Autonomy, actions, approvals
// ─────────────────────────────────────────────────────────────

/** 0 Observe · 1 Investigate · 2 Recommend · 3 Execute low-risk · 4 Human approval */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export type RiskLevel = 'low' | 'medium' | 'high';

export type ActionType =
  | 'create_task'
  | 'create_incident_draft'
  | 'notify_oncall'
  | 'draft_slack_message'
  | 'add_evidence_to_issue'
  | 'continue_monitoring'
  | 'rollback_release'
  | 'disable_payment_method'
  | 'pause_experiment'
  | 'customer_communication'
  | 'refund'
  | 'pricing_change'
  | 'production_config_change';

export type GatedCategory = 'production_changes' | 'customer_communications' | 'payments' | 'pricing' | 'refunds';

export type PolicyDecision = 'execute' | 'draft' | 'require_approval' | 'recommend_only' | 'not_permitted';

export type ActionStatus =
  | 'executed'
  | 'drafted'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'recommended'
  | 'not_permitted'
  | 'failed'
  | 'blocked';

export interface Action {
  id: string;
  investigationId: string;
  type: ActionType;
  title: string;
  description: string;
  risk: RiskLevel;
  requiredLevel: AutonomyLevel;
  gatedBy?: GatedCategory;
  decision: PolicyDecision;
  decisionReason: string;
  status: ActionStatus;
  target?: string;
  result?: string;
  createdAt: ISODateTime;
  approvalId?: string;
  taskId?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'more_evidence_requested';

export interface ApprovalRequest {
  id: string;
  actionId: string;
  investigationId: string;
  actionType: ActionType;
  title: string;
  risk: RiskLevel;
  gatedBy: GatedCategory;
  reason: string;
  evidenceIds: string[];
  evidenceSources: SourceKind[];
  potentialImpact: string;
  reversibility: string;
  confidence: number;
  requestedAt: ISODateTime;
  status: ApprovalStatus;
  decidedAt?: ISODateTime;
  decisionNote?: string;
  executionResult?: string;
  supplementalEvidence: Evidence[];
  fingerprint: string;
}

// ─────────────────────────────────────────────────────────────
// Work
// ─────────────────────────────────────────────────────────────

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskStatus = 'todo' | 'in_progress' | 'done';

export interface TaskDescription {
  problem: string;
  impact: string;
  evidence: string[];
  hypothesis: string;
  confidence: string;
  nextStep: string;
  sources: SourceKind[];
}

export interface TaskComment {
  at: ISODateTime;
  author: 'nightwatch' | 'you';
  body: string;
}

export interface Task {
  id: string;
  kind: 'task' | 'incident';
  title: string;
  priority: Priority;
  ownerTeamId: string;
  createdBy: 'nightwatch' | 'human';
  createdAt: ISODateTime;
  status: TaskStatus;
  investigationId?: string;
  evidenceSourceCount: number;
  description: TaskDescription;
  comments: TaskComment[];
  fingerprint?: string;
  tracker: 'simulated';
}

/** A task Nightwatch has prepared but not filed (policy said draft, or the PM wants to review first). */
export interface TaskDraft {
  investigationId: string;
  kind: 'task' | 'incident';
  title: string;
  priority: Priority;
  ownerTeamId: string;
  description: TaskDescription;
  evidenceSourceCount: number;
  fingerprint: string;
}

// ─────────────────────────────────────────────────────────────
// Trace & audit
// ─────────────────────────────────────────────────────────────

export type AgentStage =
  | 'start'
  | 'collect'
  | 'detect'
  | 'prioritize'
  | 'investigate'
  | 'evidence'
  | 'hypothesis'
  | 'confidence'
  | 'risk'
  | 'decide'
  | 'act'
  | 'approval'
  | 'brief'
  | 'human';

export type EventStatus = 'ok' | 'info' | 'warning' | 'error' | 'blocked' | 'skipped';

export interface AgentEvent {
  id: string;
  seq: number;
  runId: string;
  at: ISODateTime;
  stage: AgentStage;
  agent: 'nightwatch' | 'you';
  action: string;
  tool?: string;
  input?: string;
  output?: string;
  result: string;
  status: EventStatus;
  decision?: string;
  risk?: RiskLevel;
  approvalStatus?: 'not_required' | 'required' | 'pending' | 'approved' | 'rejected';
  investigationId?: string;
  durationMs?: number;
  /** Routine events are collapsed by default in the trace. */
  routine?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Brief
// ─────────────────────────────────────────────────────────────

export interface BriefEvidenceItem {
  label: string;
  value: string;
  tone: 'bad' | 'neutral' | 'good';
  source: SourceKind;
}

export interface BriefFinding {
  investigationId: string;
  severity: Severity;
  title: string;
  summary: string;
  confidence?: number;
  status: InvestigationStatus;
  route: EscalationRoute;
}

export interface BriefNotDone {
  label: string;
  status: string;
  reason: string;
  approvalId?: string;
}

export interface MorningBrief {
  runId: string;
  generatedAt: ISODateTime;
  window: { start: ISODateTime; end: ISODateTime };
  counts: { critical: number; attention: number; normal: number; signals: number; anomalies: number; dismissed: number };
  headline?: {
    investigationId: string;
    severity: Severity;
    metricName: string;
    changePct: number;
    confidence?: number;
    statement: string;
    status: InvestigationStatus;
  };
  evidence: BriefEvidenceItem[];
  did: string[];
  didNot: BriefNotDone[];
  findings: BriefFinding[];
  escalations: string[];
  quiet: boolean;
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export type GateSetting = 'require_approval' | 'disabled';

export interface AutonomyPolicy {
  observe: boolean;
  investigate: boolean;
  recommend: boolean;
  createTasks: boolean;
  /** Findings at or above this severity get tasks filed automatically; below it Nightwatch drafts them. */
  autoFileMinSeverity: AlertSeverity | 'never';
  createIncidents: boolean;
  gates: Record<GatedCategory, GateSetting>;
}

export interface Team {
  id: string;
  name: string;
  keyPrefix: string;
  onCall: string;
}

export interface Owner {
  area: ProductArea;
  teamId: string;
}

export interface WorkspaceSettings {
  watch: Record<WatchArea, boolean>;
  thresholds: Record<SignalCategory, number>;
  owners: Owner[];
  autonomy: AutonomyPolicy;
  escalation: Record<AlertSeverity, EscalationRoute>;
  schedule: { start: string; end: string; briefAt: string };
  criticalEscalation: boolean;
  integrations: Record<SourceKind, IntegrationStatus>;
}

export type IntegrationStatus = 'connected' | 'unavailable';

export interface Integration {
  kind: SourceKind;
  name: string;
  adapter: string;
  mode: 'simulation';
  status: IntegrationStatus;
  capabilities: string[];
  productionCandidates: string[];
}

// ─────────────────────────────────────────────────────────────
// Runs & evaluation
// ─────────────────────────────────────────────────────────────

export interface RunStats {
  signalsMonitored: number;
  anomaliesDetected: number;
  investigationsCompleted: number;
  tasksCreated: number;
  recommendations: number;
  actionsExecuted: number;
  approvalsRequested: number;
  avgInvestigationSeconds: number;
}

export interface OvernightRun {
  id: string;
  scenarioId: string;
  scenarioName: string;
  startedAt: ISODateTime;
  endedAt: ISODateTime;
  reasoningEngine: string;
  signals: Signal[];
  investigations: Investigation[];
  actions: Action[];
  approvals: ApprovalRequest[];
  tasks: Task[];
  drafts: TaskDraft[];
  events: AgentEvent[];
  observations: Observation[];
  brief: MorningBrief;
  stats: RunStats;
}

export interface EvaluationCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface EvaluationResult {
  scenarioId: string;
  passed: boolean;
  checks: EvaluationCheck[];
  falseAlerts: number;
  missedIssues: number;
  approvalViolations: number;
  summary: string;
}

export interface EvaluationScenarioMeta {
  id: string;
  number: string;
  name: string;
  description: string;
  expected: string[];
}
