import type { ActionDecision, ActionKind, MonitoringResult, ProposedAction, SignalKey, ToolName, TraceStep, Watch, WatchInvestigation, WatchSignal } from '../types';

/**
 * Migration: vendor-named workspace data (product state v2) → role-based (v3).
 *
 * Before the role refactor, watches, signals, tools and actions were named after the Sample
 * workspace's vendors ("ga4.checkout_conversion", "getJiraRelease", "create_jira_incident"). This
 * rewrites a stored workspace to the role-based names without losing anything the user decided:
 * watch settings and custom thresholds are kept, and every approval stays attached to its action.
 *
 * Pure and total: unknown values pass through unchanged, so a partially-migrated or hand-edited
 * workspace never throws.
 */

const SIGNAL: Record<string, SignalKey> = {
  'ga4.checkout_conversion': 'metric:checkout_conversion',
  'ga4.signup_conversion': 'metric:signup_conversion',
  'ga4.search_usage': 'metric:search_usage',
  'ga4.purchase_revenue': 'metric:purchase_revenue',
  'app_store.crash_free_sessions': 'metric:crash_free_sessions_ios',
  'google_play.crash_free_sessions': 'metric:crash_free_sessions_android',
  'jira.issues': 'work_items',
  'app_store.reviews': 'feedback',
  'google_play.reviews': 'feedback',
  releases: 'changes',
};

const METRIC: Record<string, string> = {
  'ga4.checkout_conversion': 'checkout_conversion',
  'ga4.signup_conversion': 'signup_conversion',
  'ga4.search_usage': 'search_usage',
  'ga4.purchase_revenue': 'purchase_revenue',
  'ga4.sessions': 'sessions',
  'app_store.crash_free_sessions': 'crash_free_sessions_ios',
  'google_play.crash_free_sessions': 'crash_free_sessions_android',
};

const TOOL: Record<string, ToolName> = {
  getAnalyticsMetric: 'getMetric',
  getAnalyticsTraffic: 'getMetric',
  getStoreCrashRate: 'getMetric',
  getJiraRelease: 'getChanges',
  getStoreReleases: 'getChanges',
  getRecentJiraIssues: 'getWorkItems',
  getAppStoreReviews: 'getFeedback',
  getPlayStoreReviews: 'getFeedback',
};

const ACTION: Record<string, ActionKind> = {
  link_issues: 'link_work_items',
  create_jira_task: 'create_work_item',
  create_jira_incident: 'create_incident',
};

export const migrateSignalKey = (k: string): SignalKey => SIGNAL[k] ?? (k as SignalKey);
export const migrateMetricId = (id: string): string => METRIC[id] ?? id;
export const migrateToolName = (t: string): ToolName => TOOL[t] ?? (t as ToolName);
export const migrateActionKind = (k: string): ActionKind => ACTION[k] ?? (k as ActionKind);

/** Action ids are `act-<investigation>-<kind>`; the kind suffix is renamed with the kind. */
export function migrateActionId(id: string): string {
  const m = id.match(/^(act-.+)-([a-z_]+)$/);
  return m && ACTION[m[2]] ? `${m[1]}-${ACTION[m[2]]}` : id;
}

export function migrateWatch(w: Watch): Watch {
  const signals: WatchSignal[] = [];
  for (const s of w.signals) {
    const key = migrateSignalKey(s.key);
    // Two store review signals become one feedback signal (it reads every feedback source).
    if (!signals.some((x) => x.key === key && x.area === s.area)) signals.push({ ...s, key });
  }
  const thresholds = w.thresholds ? Object.fromEntries(Object.entries(w.thresholds).map(([k, v]) => [migrateMetricId(k), v])) : undefined;
  return { ...w, signals, ...(thresholds ? { thresholds } : {}) };
}

function migrateAction(a: ProposedAction): ProposedAction {
  return { ...a, id: migrateActionId(a.id), kind: migrateActionKind(a.kind) };
}

function migrateStep(s: TraceStep): TraceStep {
  return s.tool ? { ...s, tool: migrateToolName(s.tool) } : s;
}

function migrateInvestigation(i: WatchInvestigation): WatchInvestigation {
  return {
    ...i,
    signals: i.signals.map((s) => ({ ...s, key: migrateSignalKey(s.key) })),
    evidence: i.evidence.map((e) => (e.query ? { ...e, query: { ...e.query, tool: migrateToolName(e.query.tool) } } : e)),
    trace: i.trace.map(migrateStep),
    actions: i.actions.map(migrateAction),
  };
}

export function migrateResult(r: MonitoringResult): MonitoringResult {
  return { ...r, investigations: r.investigations.map(migrateInvestigation), actions: r.actions.map(migrateAction) };
}

/** Decisions are keyed by action id — rename the keys so each approval stays with its action. */
export function migrateDecisions(d: Record<string, ActionDecision>): Record<string, ActionDecision> {
  return Object.fromEntries(Object.entries(d).map(([id, v]) => [migrateActionId(id), v]));
}
