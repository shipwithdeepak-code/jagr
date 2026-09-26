import { fmtTime, minutesBetween } from '../lib/time.js';
import type { Area, DetectedSignal, EvidenceItem, Hypothesis, ProviderId, SourceLink } from '../types.js';
import { AREA_LABEL, signalMeta } from '../catalog.js';
import { labelOf, makeLink, type ProviderLabels } from '../integrations/adapters.js';
import type { ChangeKind, ChangeRecord, ChangeTiming, FeedbackItem, MetricSeries, WorkItem } from '../roles/types.js';
import { fmtMagnitude, type MetricReading } from './detect.js';
import { telemetryFindings, telemetryReadings, type TelemetrySignalKind } from './telemetry.js';

/**
 * Correlation and write-up. Evidence is gathered by the agent (src/product/agent/investigator.ts);
 * this turns it into what is Observed, what is Inferred and what is Unknown.
 * Correlation is never stated as causation.
 */

export interface Gathered {
  evidence: EvidenceItem[];
  /** Sources whose data is missing (down, not configured, no such metric) or incomplete (stale). */
  gaps: { provider: ProviderId; detail: string; noData?: boolean; stale?: boolean; freshAsOf?: string }[];
  notInWatch: ProviderId[];
  changes: ChangeRecord[];
  workItems: WorkItem[];
  feedback: FeedbackItem[];
  areaMetric?: { series: MetricSeries; reading: MetricReading };
  trafficStable?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Changes: which one (if any) preceded the degradation
// ─────────────────────────────────────────────────────────────

/** How a change is named in prose: "release 4.8.1", "deploy checkout-api@9f1c", "flag change “new-checkout”". */
export function changePhrase(kind: ChangeKind | undefined, label: string): string {
  switch (kind) {
    case 'deploy':
      return `deploy ${label}`;
    case 'flag_change':
      return `flag change “${label}”`;
    case 'experiment_change':
      return `experiment change “${label}”`;
    case 'config_change':
      return `configuration change “${label}”`;
    case 'annotation':
      return `annotated change “${label}”`;
    case 'incident':
      return `incident “${label}”`;
    default:
      return `release ${label}`;
  }
}

export const changeLabel = (c: ChangeRecord) => c.version ?? c.title;

/** Changes whose timestamp says when something reached users. Planned dates and incidents are not. */
export const timedChange = (c: ChangeRecord) => c.kind !== 'incident' && c.timing !== 'planned';

/**
 * The change associated with a degradation, by timing only — never a cause.
 *
 * Only a change with an `actual` or `reported` time can be associated. A change known only by a
 * planned date is never associated (the date is not when it reached users), and when a change has
 * both, the observed time wins — even when it puts the change after the degradation began.
 * The association is measured from the change's first observed record before onset.
 */
export function associateChange(changes: ChangeRecord[], onsetAt: string, maxMinutesBefore = 180): { version: string; releasedAt: string; minutesBeforeOnset: number; kind: ChangeKind; timing: ChangeTiming } | undefined {
  const candidates = changes.filter((r) => timedChange(r) && Date.parse(r.at) <= Date.parse(onsetAt) + 15 * 60_000 && minutesBetween(r.at, onsetAt) <= maxMinutesBefore);
  const nearest = [...candidates].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!nearest) return undefined;
  const first = candidates.filter((r) => changeLabel(r) === changeLabel(nearest)).sort((a, b) => a.at.localeCompare(b.at))[0];
  return { version: changeLabel(first), releasedAt: first.at, minutesBeforeOnset: Math.max(0, Math.round(minutesBetween(first.at, onsetAt))), kind: first.kind, timing: first.timing };
}

/** A change dated shortly before onset but known only by a planned date — reported as an unknown, never associated. */
export function plannedOnly(changes: ChangeRecord[], onsetAt: string, maxMinutesBefore = 180): ChangeRecord | undefined {
  const observed = new Set(changes.filter(timedChange).map(changeLabel));
  return changes
    .filter((r) => r.kind !== 'incident' && r.timing === 'planned' && !observed.has(changeLabel(r)) && Date.parse(r.at) <= Date.parse(onsetAt) + 15 * 60_000 && minutesBetween(r.at, onsetAt) <= maxMinutesBefore)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}

function fmtValue(series: MetricSeries, v: number) {
  if (series.unit === 'percent') return `${v.toFixed(2)}%`;
  if (series.unit === 'currency') return `$${Math.round(v).toLocaleString('en-US')}`;
  return Math.round(v).toLocaleString('en-US');
}

/** Evidence item for a metric reading — a factual statement, with a deep link to the series. */
export function metricEvidence(series: MetricSeries, reading: MetricReading, simulated: boolean, labels?: ProviderLabels): EvidenceItem {
  const P = labelOf(labels);
  const ref = series.ref;
  const link = makeLink(ref, `Open ${P(series.source).short}`, simulated, series.provenance?.url);
  const degraded = reading.status !== 'normal';
  const statement = degraded
    ? `${P(series.source).short}: ${series.name} is ${fmtValue(series, reading.currentSinceOnset)} vs ${fmtValue(series, series.baseline.mean)} baseline (${fmtMagnitude(series, reading)}) since ${fmtTime(reading.onsetAt!)}.`
    : `${P(series.source).short}: ${series.name} is within its normal range (${fmtMagnitude(series, reading)} vs baseline).`;
  const p = series.provenance;
  return {
    id: `${series.source}:metric:${series.key}`,
    provider: series.source,
    direction: degraded ? 'degraded' : 'stable',
    statement,
    onsetAt: reading.onsetAt,
    refs: [ref],
    link,
    // Snapshot: the readings the statement rests on, as read.
    provenance: { mode: p?.mode, sources: [series.source], fetchedAt: p?.fetchedAt ?? series.points[series.points.length - 1]?.t ?? '', records: p ? [{ externalId: p.externalId, url: p.url, observedAt: p.observedAt }] : [], values: { metric: series.name, current: degraded ? reading.currentSinceOnset : reading.current, baseline: series.baseline.mean, baselineWindow: series.baseline.window, unit: series.unit, ...(series.telemetry ? { telemetry: series.telemetry } : {}) } },
  };
}

// ─────────────────────────────────────────────────────────────
// Correlation, confidence and write-up
// ─────────────────────────────────────────────────────────────

export interface Reasoning {
  correlatedProviders: ProviderId[];
  corroborating: number;
  releaseAssociation?: { version: string; releasedAt: string; minutesBeforeOnset: number };
  confidence: number;
  confidenceReason: string;
  observed: string[];
  inferred: string[];
  unknowns: string[];
  hypotheses: Hypothesis[];
  likelyExplanation: string;
  uncertainty: string;
  recommendedNextStep: string;
  title: string;
  sourceLinks: SourceLink[];
  /** Error and crash telemetry findings, when a telemetry source was part of the investigation. */
  telemetrySignals: TelemetrySignalKind[];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function reason(primary: DetectedSignal, signals: DetectedSignal[], g: Gathered, area: Area, onsetAt: string, critical: boolean, persistent = true, labels?: ProviderLabels, simulatedLinks: (p: ProviderId) => boolean = () => true): Reasoning {
  const P = labelOf(labels);
  const degraded = g.evidence.filter((e) => e.direction === 'degraded');
  // Error / crash telemetry the monitor detected is an independent observation in its own right, even
  // when the agent's budget went on other questions: it corroborates, and it is stated as observed.
  const telemetrySignals = signals.filter((s) => s.telemetry && s !== primary);
  const correlatedProviders = [...new Set([primary.provider, ...degraded.map((e) => e.provider), ...telemetrySignals.map((s) => s.provider)])];
  const corroborating = correlatedProviders.filter((p) => p !== primary.provider).length;
  const areaLabel = AREA_LABEL[area].toLowerCase();

  // A change is associated only by timing — reached users within 3h before the degradation began.
  const releaseAssociation = associateChange(g.changes, onsetAt);
  const planned = releaseAssociation ? undefined : plannedOnly(g.changes, onsetAt);
  const assocPhrase = releaseAssociation ? changePhrase(releaseAssociation.kind, releaseAssociation.version) : '';

  const primaryMeta = signalMeta(primary.key);
  const customerPrimary = primaryMeta.kind === 'feedback' || primaryMeta.kind === 'work_items';
  const areaMetricStable = g.areaMetric?.reading.status === 'normal';
  const strength = Math.min(1, primary.ratio / 2);

  // Confidence that this is a real degradation in the area — NOT confidence in a cause.
  let score = -1.5 + 1.4 * strength + 0.9 * Math.min(corroborating, 3);
  if (g.trafficStable && !customerPrimary) score += 0.3;
  if (releaseAssociation) score += 0.3;
  if (customerPrimary && areaMetricStable) score -= 0.3;
  score -= 0.5 * g.gaps.length;
  // A reading that hasn't persisted yet could be noise, however many sources wobble with it.
  if (!persistent) score -= 2.5;
  const confidence = Math.round(Math.min(0.93, Math.max(0.05, sigmoid(score))) * 100) / 100;
  const confidenceReason = `${correlatedProviders.length} ${correlatedProviders.length === 1 ? 'source shows' : 'independent sources show'} the degradation${g.gaps.length ? `; ${g.gaps.length} source${g.gaps.length === 1 ? ' was' : 's were'} unavailable, which lowers confidence` : ''}. This is confidence that the ${areaLabel} problem is real, not that its cause is known.`;

  const observed = g.evidence.filter((e) => e.direction !== 'gap').map((e) => e.statement);
  for (const s of telemetrySignals) {
    if (!degraded.some((e) => e.provider === s.provider && e.provenance?.values?.metric === s.label)) observed.push(`${P(s.provider).short}: ${s.label} moved ${s.magnitude} from its baseline since ${fmtTime(s.onsetAt)}.`);
  }

  const inferred: string[] = [];
  // When each source first degraded — the spread of first signals is what indicates a shared problem.
  const firstByProvider = correlatedProviders
    .map((p) => [...signals.filter((s) => s.provider === p).map((s) => s.onsetAt), ...degraded.filter((e) => e.provider === p && e.onsetAt).map((e) => e.onsetAt!)].sort()[0])
    .filter((x): x is string => !!x)
    .sort();
  const spread = firstByProvider.length > 1 ? Math.round(minutesBetween(firstByProvider[0], firstByProvider[firstByProvider.length - 1])) : 0;
  if (corroborating >= 1) inferred.push(`${correlatedProviders.length} sources first degraded within ${spread} minutes of each other, so they likely reflect the same underlying ${areaLabel} problem.`);
  if (releaseAssociation) inferred.push(`The degradation began ${releaseAssociation.minutesBeforeOnset} minutes after ${assocPhrase}${releaseAssociation.timing === 'reported' ? ' (a reported time)' : ''} — a temporal association.`);
  if (g.trafficStable && !customerPrimary) inferred.push('Traffic is normal, so the change is in how people convert, not in how many arrive.');
  if (customerPrimary && areaMetricStable) inferred.push(`Customers are reporting ${areaLabel} problems, but analytics does not yet show a measurable impact.`);
  if (corroborating === 0 && !customerPrimary) inferred.push('Only one source shows this change; it may be a real shift or a measurement issue.');

  // "No release found" is only true if someone looked. A skipped or failed lookup is not a negative.
  const releaseChecked = g.changes.length > 0 || g.evidence.some((e) => e.query?.tool === 'getChanges');
  const unknowns: string[] = [];
  unknowns.push(
    releaseAssociation
      ? `Whether ${assocPhrase} is responsible — timing alone does not establish causation.`
      : planned
        ? `When ${changePhrase(planned.kind, changeLabel(planned))} reached users — only its planned date (${fmtTime(planned.at)}) is known, which is not evidence of timing.`
        : releaseChecked
          ? 'What is behind the change — no release or other change was found in the window.'
          : 'Whether a release or change is involved — release history was not checked in this investigation.',
  );
  // Error and crash telemetry: what it adds, when a telemetry source was read in this investigation.
  const readings = telemetryReadings(signals, g.evidence);
  const telemetryEvidence = g.evidence.filter((e) => e.provenance?.values?.telemetry && e.direction !== 'gap');
  const telemetryProviders = new Set([...readings.map((r) => r.provider), ...telemetryEvidence.map((e) => e.provider)]);
  const telemetryChecked = telemetryProviders.size > 0;
  const telemetry = telemetryFindings({
    readings,
    sourceNames: [...telemetryProviders].map((p) => P(p).short),
    telemetryStable: telemetryEvidence.some((e) => e.direction === 'stable'),
    otherDegraded: correlatedProviders.filter((p) => !telemetryProviders.has(p)).map((p) => P(p).short),
    change: releaseAssociation ? { phrase: assocPhrase, minutesBeforeOnset: releaseAssociation.minutesBeforeOnset } : undefined,
    areaLabel,
  });
  inferred.push(...telemetry.inferred);
  unknowns.push(...telemetry.unknowns);

  for (const gap of g.gaps) unknowns.push(gap.detail);
  for (const p of g.notInWatch) unknowns.push(`${P(p).name} is not part of this watch, so it was not checked.`);
  if (telemetryChecked) {
    if (area === 'checkout') unknowns.push('Payment-provider data is not connected to Jagr.');
  } else if (area === 'checkout') unknowns.push('Payment-provider and server error data are not connected to Jagr.');
  else unknowns.push('Server-side error data is not connected to Jagr.');

  const hypotheses: Hypothesis[] = [];
  if (releaseAssociation) hypotheses.push({ statement: `${AREA_LABEL[area]} degradation temporally associated with ${assocPhrase}`, basis: 'temporal_correlation', role: 'leading' });
  else if (corroborating >= 1) hypotheses.push({ statement: `A shared ${areaLabel} problem visible across ${correlatedProviders.map((p) => P(p).short).join(', ')}`, basis: 'cross_source', role: 'leading' });
  else if (customerPrimary) hypotheses.push({ statement: `A customer-reported ${areaLabel} problem not yet visible in analytics`, basis: 'customer_reports', role: 'leading' });
  else hypotheses.push({ statement: `${primary.label} decline without corroborating signals`, basis: 'single_source', role: 'leading' });
  hypotheses.push({ statement: 'An unrelated factor outside the connected sources (payment provider, backend, marketing change)', basis: 'outside_sources', role: 'alternative' });

  let likelyExplanation: string;
  if (releaseAssociation) {
    likelyExplanation = `${primary.label} ${customerPrimary ? 'rose' : 'declined'} shortly after ${assocPhrase}${corroborating ? ` and ${correlatedProviders.filter((p) => p !== primary.provider).map((p) => P(p).short).join(', ')} also ${corroborating > 1 ? 'show' : 'shows'} ${areaLabel} problems` : ''}. The available evidence supports a temporal correlation, but does not establish causation.`;
  } else if (corroborating >= 1) {
    likelyExplanation = `${correlatedProviders.length} sources show ${areaLabel} degrading at the same time, which suggests a shared underlying problem.${releaseChecked ? ' No release or change in the window lines up with it.' : ' Release history was not checked.'}`;
  } else if (customerPrimary) {
    likelyExplanation = `Customers are reporting ${areaLabel} problems, but analytics does not show a measurable impact yet.`;
  } else {
    likelyExplanation = `Only ${P(primary.provider).short} shows this change. There is not enough evidence to explain it.`;
  }

  const staged = g.changes.find((r) => r.rollout && /staged/i.test(r.rollout) && r.version === releaseAssociation?.version);
  const uncertainty = [
    'The data does not establish causation.',
    ...g.gaps.map((x) => (x.stale ? `${P(x.provider).name} data is incomplete after ${fmtTime(x.freshAsOf!)}.` : `${P(x.provider).name} could not be checked.`)),
    corroborating === 0 ? 'No second source confirms the change.' : '',
    area === 'checkout' ? 'Payment-provider data is not connected, so a third-party payment problem cannot be ruled out.' : '',
    staged ? `${staged.platform === 'android' ? 'Android' : 'iOS'} ${staged.version} is on a ${staged.rollout!.toLowerCase()}, so impact there may still grow.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const issueKeys = g.workItems.slice(0, 2).map((i) => i.id);
  let recommendedNextStep: string;
  if (critical) recommendedNextStep = `Escalate to the ${areaLabel} owner now and review ${releaseAssociation ? `errors and crash reports for ${releaseAssociation.version}` : 'error logs'}${issueKeys.length ? `, starting with ${issueKeys.join(' and ')}` : ''}.`;
  else if (releaseAssociation) recommendedNextStep = `Review ${areaLabel} errors and crash reports associated with ${releaseAssociation.version}${issueKeys.length ? `, and triage ${issueKeys.join(' and ')}` : ''}.`;
  else if (customerPrimary) recommendedNextStep = `Read the linked reviews and check ${areaLabel} error logs for the affected app version.`;
  else if (corroborating >= 1) recommendedNextStep = `Triage the linked ${areaLabel} issues and check for changes outside Jagr's sources.`;
  else recommendedNextStep = `Check the ${primary.label.toLowerCase()} tracking and compare with backend data before acting.`;

  let title: string;
  if (correlatedProviders.length >= 3) title = area === 'stability' ? 'App stability degraded' : `${AREA_LABEL[area]} health degraded`;
  else if (customerPrimary) title = `${AREA_LABEL[area]} complaints rising`;
  else if (primaryMeta.purpose === 'stability') title = 'App stability degraded';
  else title = `${primary.label} declined`;

  const sourceLinks: SourceLink[] = [];
  const seen = new Set<string>();
  for (const e of [...g.evidence.filter((x) => x.direction === 'degraded'), ...g.evidence.filter((x) => x.direction === 'change')]) {
    if (e.link && !seen.has(e.link.href)) {
      seen.add(e.link.href);
      sourceLinks.push(e.link);
    }
  }
  for (const s of signals) for (const r of s.refs) {
    const l = makeLink(r, `Open ${P(r.provider).short}`, simulatedLinks(r.provider));
    if (!seen.has(l.href)) {
      seen.add(l.href);
      sourceLinks.push(l);
    }
  }

  return { correlatedProviders, corroborating, releaseAssociation, confidence, confidenceReason, observed, inferred, unknowns, hypotheses, likelyExplanation, uncertainty, recommendedNextStep, title, sourceLinks, telemetrySignals: telemetry.kinds };
}
