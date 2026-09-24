/**
 * Causality guard. Jagr reports correlation, never causation. Any generated sentence that asserts a
 * cause ("caused", "due to", "root cause", …) without explicitly disclaiming it counts as an overclaim.
 */

const CAUSAL = /\b(caused|causes|causing|root cause|due to|because of|resulted in|results in|led to|leads to|broke|triggered)\b/i;
const DISCLAIMED = /\b(not|no|cannot|can't|does not|doesn't|did not|whether)\b[^.]{0,60}\b(caus|establish|responsib)/i;

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

export function overclaimingSentences(text: string): string[] {
  return sentences(text).filter((s) => CAUSAL.test(s) && !DISCLAIMED.test(s));
}

export function hasCausalOverclaim(text: string): boolean {
  return overclaimingSentences(text).length > 0;
}
