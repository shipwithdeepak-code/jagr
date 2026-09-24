import { fmtTime, minutesBetween } from '../lib/time';
import type { Area, DetectedSignal, EvidenceItem, Hypothesis, ProviderId, SourceLink } from '../types';
import { AREA_LABEL, signalMeta } from '../catalog';
import { labelOf, makeLink, type ProviderLabels } from '../integrations/adapters';
import type { ChangeRecord, FeedbackItem, MetricSeries, WorkItem } from '../roles/types';
import { fmtMagnitude, type MetricReading } from './detect';

/**
 * Correlation and write-up. Evidence is gathered by the agent (src/product/agent/investigator.ts);
 * this turns it into what is Observed, what is Inferred and what is Unknown.
 * Correlation is never stated as causation.
 */

export interface Gathered {
  evidence: EvidenceItem[];
  gaps: { provider: ProviderId; detail: string; noData?: boolean }[];
  notInWatch: ProviderId[];
  changes: ChangeRecord[];
  workItems: WorkItem[];
  feedback: FeedbackItem[];
  areaMetric?: { series: MetricSeries; reading: MetricReading };
  trafficStable?: boolean;
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
  const link = makeLink(ref, `Open ${P(series.source).short}`, simulated);
  const degraded = reading.status !== 'normal';
  const statement = degraded
    ? `${P(series.source).short}: ${series.name} is ${fmtValue(series, reading.currentSinceOnset)} vs ${fmtValue(series, series.baseline.mean)} baseline (${fmtMagnitude(series, reading)}) since ${fmtTime(reading.onsetAt!)}.`
    : `${P(series.source).short}: ${series.name} is within its normal range (${fmtMagnitude(series, reading)} vs baseline).`;
  return { id: `${series.source}:metric:${series.key}`, provider: series.source, direction: degraded ? 'degraded' : 'stable', statement, onsetAt: reading.onsetAt, refs: [ref], link };
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
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function reason(primary: DetectedSignal, signals: DetectedSignal[], g: Gathered, area: Area, onsetAt: string, critical: boolean, persistent = true, labels?: ProviderLabels): Reasoning {
  const P = labelOf(labels);
  const degraded = g.evidence.filter((e) => e.direction === 'degraded');
  const correlatedProviders = [...new Set([primary.provider, ...degraded.map((e) => e.provider)])];
  const corroborating = correlatedProviders.filter((p) => p !== primary.provider).length;
  const areaLabel = AREA_LABEL[area].toLowerCase();

  // A change (release) is associated only by timing: shipped within 3h before the degradation began.
  const candidates = g.changes.filter((r) => r.version && Date.parse(r.at) <= Date.parse(onsetAt) + 15 * 60_000 && minutesBetween(r.at, onsetAt) <= 180);
  // Most recent version shipped before onset; measure from that version's first release.
  const nearest = candidates.sort((a, b) => b.at.localeCompare(a.at))[0];
  const first = nearest ? candidates.filter((r) => r.version === nearest.version).sort((a, b) => a.at.localeCompare(b.at))[0] : undefined;
  const releaseAssociation = first ? { version: first.version!, releasedAt: first.at, minutesBeforeOnset: Math.max(0, Math.round(minutesBetween(first.at, onsetAt))) } : undefined;

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

  const inferred: string[] = [];
  // When each source first degraded — the spread of first signals is what indicates a shared problem.
  const firstByProvider = correlatedProviders
    .map((p) => [...signals.filter((s) => s.provider === p).map((s) => s.onsetAt), ...degraded.filter((e) => e.provider === p && e.onsetAt).map((e) => e.onsetAt!)].sort()[0])
    .filter((x): x is string => !!x)
    .sort();
  const spread = firstByProvider.length > 1 ? Math.round(minutesBetween(firstByProvider[0], firstByProvider[firstByProvider.length - 1])) : 0;
  if (corroborating >= 1) inferred.push(`${correlatedProviders.length} sources first degraded within ${spread} minutes of each other, so they likely reflect the same underlying ${areaLabel} problem.`);
  if (releaseAssociation) inferred.push(`The degradation began ${releaseAssociation.minutesBeforeOnset} minutes after release ${releaseAssociation.version} — a temporal association.`);
  if (g.trafficStable && !customerPrimary) inferred.push('Traffic is normal, so the change is in how people convert, not in how many arrive.');
  if (customerPrimary && areaMetricStable) inferred.push(`Customers are reporting ${areaLabel} problems, but analytics does not yet show a measurable impact.`);
  if (corroborating === 0 && !customerPrimary) inferred.push('Only one source shows this change; it may be a real shift or a measurement issue.');

  // "No release found" is only true if someone looked. A skipped or failed lookup is not a negative.
  const releaseChecked = g.changes.length > 0 || g.evidence.some((e) => e.query?.tool === 'getChanges');
  const unknowns: string[] = [];
  unknowns.push(
    releaseAssociation
      ? `Whether release ${releaseAssociation.version} is responsible — timing alone does not establish causation.`
      : releaseChecked
        ? 'What is behind the change — no release or other change was found in the window.'
        : 'Whether a release or change is involved — release history was not checked in this investigation.',
  );
  for (const gap of g.gaps) unknowns.push(gap.detail);
  for (const p of g.notInWatch) unknowns.push(`${P(p).name} is not part of this watch, so it was not checked.`);
  if (area === 'checkout') unknowns.push('Payment-provider and server error data are not connected to Jagr.');
  else unknowns.push('Server-side error data is not connected to Jagr.');

  const hypotheses: Hypothesis[] = [];
  if (releaseAssociation) hypotheses.push({ statement: `${AREA_LABEL[area]} degradation temporally associated with release ${releaseAssociation.version}`, basis: 'temporal_correlation', role: 'leading' });
  else if (corroborating >= 1) hypotheses.push({ statement: `A shared ${areaLabel} problem visible across ${correlatedProviders.map((p) => P(p).short).join(', ')}`, basis: 'cross_source', role: 'leading' });
  else if (customerPrimary) hypotheses.push({ statement: `A customer-reported ${areaLabel} problem not yet visible in analytics`, basis: 'customer_reports', role: 'leading' });
  else hypotheses.push({ statement: `${primary.label} decline without corroborating signals`, basis: 'single_source', role: 'leading' });
  hypotheses.push({ statement: 'An unrelated factor outside the connected sources (payment provider, backend, marketing change)', basis: 'outside_sources', role: 'alternative' });

  let likelyExplanation: string;
  if (releaseAssociation) {
    likelyExplanation = `${primary.label} ${customerPrimary ? 'rose' : 'declined'} shortly after release ${releaseAssociation.version}${corroborating ? ` and ${correlatedProviders.filter((p) => p !== primary.provider).map((p) => P(p).short).join(', ')} also ${corroborating > 1 ? 'show' : 'shows'} ${areaLabel} problems` : ''}. The available evidence supports a temporal correlation, but does not establish causation.`;
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
    ...g.gaps.map((x) => `${P(x.provider).name} could not be checked.`),
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
    const l = makeLink(r, `Open ${P(r.provider).short}`, true);
    if (!seen.has(l.href)) {
      seen.add(l.href);
      sourceLinks.push(l);
    }
  }

  return { correlatedProviders, corroborating, releaseAssociation, confidence, confidenceReason, observed, inferred, unknowns, hypotheses, likelyExplanation, uncertainty, recommendedNextStep, title, sourceLinks };
}
