import type { ConfidenceBand, Evidence, EvidenceWeight, Hypothesis, HypothesisType, ProductArea } from '@/domain/types';

/**
 * Hypothesis generation and confidence.
 *
 * 1. Candidate hypotheses are instantiated from the evidence (a provider outlier suggests
 *    "provider regression" and "provider outage"; a deployment suggests "release regression"; …).
 * 2. Each candidate is scored in log-odds: prior + Σ evidence weights. Weights are explicit and
 *    explained, so every point of confidence can be traced to an observation.
 * 3. Scores are normalised with a softmax that includes an "unexplained" option with fixed mass,
 *    so JAGR always reserves probability for causes it cannot observe. When nothing
 *    beats "unexplained", the answer is "Insufficient evidence".
 */

export const UNEXPLAINED_LOGIT = 1.5;

export const CONFIDENCE_BANDS = { high: 0.75, medium: 0.55, low: 0.35 } as const;

export interface HypothesisCandidate {
  key: string;
  type: HypothesisType;
  statement: string;
  area: ProductArea;
  entities: string[];
  prior: number;
  proposedBy: Hypothesis['proposedBy'];
}

const PROVIDER_LABEL: Record<string, string> = { klarna: 'Klarna', paypal: 'PayPal', card: 'Card', apple_pay: 'Apple Pay' };

const PRIORS: Record<HypothesisType, number> = {
  provider_regression: -1.0,
  provider_outage: -1.2,
  release_regression: -1.0,
  demand_shift: -1.0,
  experiment_effect: -1.0,
  instrumentation: -1.5,
  unexplained: UNEXPLAINED_LOGIT,
};

/** "Activation rate — iOS" → "iOS activation rate". */
export function shortMetricName(name: string): string {
  const [base, segment] = name.split(' — ');
  return segment ? `${segment} ${base.toLowerCase()}` : base.toLowerCase();
}

function has(e: Evidence, entity: string) {
  return e.entities.includes(entity);
}

/** Which release (if any) links to a provider through a PR that touched it. */
function linkedRelease(evidence: Evidence[], provider: string): string | undefined {
  const pr = evidence.find((e) => e.kind === 'merged_pr' && has(e, provider));
  if (!pr) return undefined;
  return evidence.find((e) => e.kind === 'deployment' && pr.entities.includes(e.value ?? ''))?.value;
}

export function proposeCandidates(evidence: Evidence[], ctx: { primaryName: string; primaryArea: ProductArea; surfaces: string[] }): HypothesisCandidate[] {
  const out: HypothesisCandidate[] = [];
  const outliers = evidence.filter((e) => e.kind === 'provider_outlier' && !has(e, 'all_providers'));
  for (const o of outliers) {
    const provider = o.entities[0];
    const label = PROVIDER_LABEL[provider] ?? provider;
    const release = linkedRelease(evidence, provider);
    out.push({
      key: `provider_regression:${provider}`,
      type: 'provider_regression',
      statement: release
        ? `${label} checkout regression associated with release ${release}`
        : `${label} checkout regression (cause not yet identified)`,
      area: 'payments',
      entities: [provider, ...(release ? [release] : [])],
      prior: PRIORS.provider_regression,
      proposedBy: 'deterministic',
    });
    out.push({
      key: `provider_outage:${provider}`,
      type: 'provider_outage',
      statement: `${label}-side outage (third-party incident)`,
      area: 'payments',
      entities: [provider],
      prior: PRIORS.provider_outage,
      proposedBy: 'deterministic',
    });
  }

  for (const d of evidence.filter((e) => e.kind === 'deployment')) {
    const version = d.value ?? 'release';
    const platform = has(d, 'platform') || has(d, 'backend');
    out.push({
      key: `release_regression:${version}`,
      type: 'release_regression',
      statement: platform ? `Platform-wide regression introduced by release ${version}` : `Broad regression introduced by release ${version}`,
      area: platform ? 'platform' : has(d, 'payments-service') ? 'payments' : ctx.primaryArea,
      entities: [version],
      prior: PRIORS.release_regression,
      proposedBy: 'deterministic',
    });
  }

  if (evidence.some((e) => e.kind === 'traffic_stable' || e.kind === 'traffic_drop')) {
    out.push({
      key: 'demand_shift',
      type: 'demand_shift',
      statement: 'Fewer people reached the funnel (demand or traffic shift)',
      area: 'growth',
      entities: ['traffic'],
      prior: PRIORS.demand_shift,
      proposedBy: 'deterministic',
    });
  }

  const experiments = new Set(
    evidence.filter((e) => e.kind.startsWith('experiment_')).map((e) => e.entities[0]),
  );
  for (const name of experiments) {
    out.push({
      key: `experiment_effect:${name}`,
      type: 'experiment_effect',
      statement: `Experiment ${name} lowering ${ctx.primaryArea === 'platform' ? 'conversion' : shortMetricName(ctx.primaryName)}`,
      area: 'growth',
      entities: [name],
      prior: PRIORS.experiment_effect,
      proposedBy: 'deterministic',
    });
  }

  out.push({
    key: 'instrumentation',
    type: 'instrumentation',
    statement: 'Tracking or instrumentation change, not a real behaviour change',
    area: 'growth',
    entities: ['instrumentation'],
    prior: PRIORS.instrumentation,
    proposedBy: 'deterministic',
  });

  return out;
}

/**
 * The likelihood model. Positive = the observation is more likely if the hypothesis is true.
 * Kept as one readable function so it can be reviewed like a policy document.
 */
export function weigh(h: HypothesisCandidate, e: Evidence, all: Evidence[]): EvidenceWeight | null {
  const s = e.strength;
  const target = h.entities[0];
  const w = (weight: number, reason: string): EvidenceWeight => ({ evidenceId: e.id, weight: Math.round(weight * 1000) / 1000, reason });
  const multiProvider = all.some((x) => x.kind === 'provider_outlier' && has(x, 'all_providers'));

  switch (h.type) {
    case 'provider_regression':
      switch (e.kind) {
        case 'driver_moved': return w(0.3 * s, 'Degradation sits in checkout completion, where payment happens');
        case 'traffic_stable': return w(0.2, 'Traffic is normal, so the problem is inside checkout');
        case 'provider_outlier': return has(e, target) ? w(1.0 * s, 'This provider is the one failing') : w(-0.3, 'Another provider is also failing');
        case 'provider_normal': return w(0.18, 'Other providers are healthy — the failure is isolated');
        case 'provider_error_signature':
          if (!has(e, target)) return null;
          return has(e, 'client_error') ? w(0.65 * s, 'Failures are request-validation errors — our side') : w(-0.15, 'Failure type points elsewhere');
        case 'provider_status': return has(e, target) ? (has(e, 'operational') ? w(0.2, 'Provider reports no incident') : w(-0.55, 'Provider reports an incident')) : null;
        case 'deployment': return has(e, target) ? w(0.3 * s, 'A release touching this provider shipped at onset') : null;
        case 'merged_pr': return has(e, target) ? w(0.75 * s, 'A merged PR changed this provider integration') : null;
        case 'support_cluster': return has(e, target) ? w(0.5 * s, 'Customers name this provider in tickets') : w(0.2 * s, 'Customers report checkout failures');
        case 'reliability_spike': return w(-0.4, 'Platform-wide errors suggest a broader cause');
        default: return null;
      }

    case 'provider_outage':
      switch (e.kind) {
        case 'driver_moved': return w(0.3 * s, 'Degradation sits in checkout completion');
        case 'traffic_stable': return w(0.2, 'Traffic is normal');
        case 'provider_outlier': return has(e, target) ? w(1.0 * s, 'This provider is the one failing') : null;
        case 'provider_normal': return w(0.18, 'Other providers are healthy');
        case 'provider_error_signature':
          if (!has(e, target)) return null;
          return has(e, 'client_error') ? w(-0.85 * s, 'Validation errors mean the provider is up and rejecting our requests') : w(0.55 * s, 'Server errors/timeouts fit a provider outage');
        case 'provider_status': return has(e, target) ? (has(e, 'operational') ? w(-0.65, 'Provider status page shows no incident') : w(1.05, 'Provider has declared an incident')) : null;
        case 'merged_pr': return has(e, target) ? w(-0.4, 'Our own change to this integration is a competing explanation') : null;
        case 'support_cluster': return has(e, target) ? w(0.5 * s, 'Customers name this provider') : null;
        default: return null;
      }

    case 'release_regression':
      switch (e.kind) {
        case 'deployment': return has(e, target) ? w(0.63 * s, 'Shipped immediately before the degradation') : null;
        case 'merged_pr': return has(e, target) ? w(0.2 * s, 'Contains changes to the affected area') : null;
        case 'driver_moved': return w(0.25 * s, 'A downstream metric moved at the same time');
        case 'reliability_spike': return w(0.85, 'Platform error rates spiked — consistent with a bad release');
        case 'provider_outlier': return multiProvider ? w(0.7, 'All providers failing at once points upstream, at our release') : null;
        case 'provider_normal': return w(-0.35, 'A broad regression would affect every provider, but this one is healthy');
        case 'provider_error_signature': return has(e, 'all_providers') && has(e, 'server_error') ? w(0.4, 'Server errors across providers fit a platform regression') : null;
        case 'support_cluster': return w(0.3 * s, 'Customers are reporting failures');
        case 'segment_concentrated': return w(-0.3, 'Only one platform is affected');
        default: return null;
      }

    case 'demand_shift':
      switch (e.kind) {
        case 'traffic_stable': return w(-1.4, 'Traffic is normal — the same number of people arrived');
        case 'traffic_drop': return w(1.05 * s, 'Fewer people reached this step');
        case 'driver_moved': return w(-0.4, 'The drop is in completion, after people arrive');
        case 'provider_outlier': return w(-0.35, 'Payment failures are not a demand effect');
        case 'driver_stable': return w(-0.2, 'Upstream funnel steps are stable');
        default: return null;
      }

    case 'experiment_effect':
      switch (e.kind) {
        case 'experiment_change': return has(e, target) ? w(1.05, 'Allocation changed right before the metric moved') : null;
        case 'experiment_result': return has(e, target) ? w(1.7 * s, 'Randomised comparison shows the variant underperforming') : null;
        case 'experiment_stable': return has(e, target) ? w(-1.05, 'No change to this experiment tonight') : null;
        case 'segment_concentrated': return w(0.35, 'Decline is confined to the experiment’s platform');
        case 'no_recent_deployment': return w(0.2, 'No release that could explain it instead');
        case 'no_support_signal': return w(0.14, 'UX changes rarely generate tickets');
        case 'provider_outlier': return w(-0.4, 'Payment failures are not an experiment effect');
        default: return null;
      }

    case 'instrumentation':
      switch (e.kind) {
        case 'merged_pr': return has(e, 'instrumentation') ? w(0.55 * s, 'A tracking/analytics change shipped') : null;
        case 'provider_outlier': return w(-0.55, 'Payment failures are measured independently of product analytics');
        case 'support_cluster': return w(-0.7 * s, 'Real customers are complaining');
        case 'no_support_signal': return w(0.2, 'No customer complaints');
        case 'experiment_result': return w(-0.5, 'A randomised comparison measures the gap directly');
        case 'reliability_spike': return w(-0.4, 'Server-side metrics moved too');
        default: return null;
      }

    default:
      return null;
  }
}

export function scoreHypotheses(candidates: HypothesisCandidate[], evidence: Evidence[]): Hypothesis[] {
  const scored = candidates.map((c) => {
    const weights = evidence.map((e) => weigh(c, e, evidence)).filter((x): x is EvidenceWeight => !!x && x.weight !== 0);
    const score = c.prior + weights.reduce((a, x) => a + x.weight, 0);
    return { c, weights, score };
  });

  const denom = Math.exp(UNEXPLAINED_LOGIT) + scored.reduce((a, s) => a + Math.exp(s.score), 0);
  const hyps: Hypothesis[] = scored
    .map(({ c, weights, score }) => ({
      id: c.key,
      type: c.type,
      statement: c.statement,
      area: c.area,
      entities: c.entities,
      prior: c.prior,
      weights,
      score,
      confidence: Math.exp(score) / denom,
      status: 'alternative' as Hypothesis['status'],
      proposedBy: c.proposedBy,
    }))
    .sort((a, b) => b.confidence - a.confidence);

  hyps.forEach((h, i) => {
    h.status = i === 0 ? 'leading' : h.confidence >= 0.03 ? 'alternative' : 'ruled_out';
  });
  return hyps;
}

export function unexplainedMass(hyps: Hypothesis[]): number {
  return 1 - hyps.reduce((a, h) => a + h.confidence, 0);
}

export interface ConfidenceAssessment {
  band: ConfidenceBand;
  confidence: number;
  supportingSources: number;
  supportingCount: number;
  reason: string;
}

/**
 * Confidence is only as good as its grounding: a hypothesis needs support from at least two
 * independent sources before JAGR will state it as a finding.
 */
export function evaluateConfidence(leading: Hypothesis | undefined, evidence: Evidence[]): ConfidenceAssessment {
  if (!leading) return { band: 'insufficient', confidence: 0, supportingSources: 0, supportingCount: 0, reason: 'No hypothesis could be formed from the evidence.' };
  const supporting = leading.weights.filter((w) => w.weight > 0.05);
  const sources = new Set(supporting.map((w) => evidence.find((e) => e.id === w.evidenceId)?.source).filter(Boolean));
  const c = leading.confidence;
  if (sources.size < 2 || c < CONFIDENCE_BANDS.low) {
    return {
      band: 'insufficient',
      confidence: c,
      supportingSources: sources.size,
      supportingCount: supporting.length,
      reason:
        sources.size < 2
          ? `Support comes from ${sources.size === 0 ? 'no' : 'only one'} source — not enough to state a cause.`
          : `The best explanation reaches only ${Math.round(c * 100)}%; most probability remains unexplained.`,
    };
  }
  const band: ConfidenceBand = c >= CONFIDENCE_BANDS.high ? 'high' : c >= CONFIDENCE_BANDS.medium ? 'medium' : 'low';
  return {
    band,
    confidence: c,
    supportingSources: sources.size,
    supportingCount: supporting.length,
    reason: `${supporting.length} supporting observations across ${sources.size} independent sources.`,
  };
}

/** Mark each evidence item's stance relative to the leading hypothesis (for the UI and the graph). */
export function applyStances(evidence: Evidence[], leading: Hypothesis | undefined): Evidence[] {
  return evidence.map((e) => {
    if (e.kind === 'source_unavailable') return { ...e, stance: 'gap' };
    const w = leading?.weights.find((x) => x.evidenceId === e.id)?.weight ?? 0;
    return { ...e, stance: w > 0.05 ? 'supports' : w < -0.05 ? 'contradicts' : 'context' };
  });
}
