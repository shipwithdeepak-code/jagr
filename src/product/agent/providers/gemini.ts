import { defaultFetch, ProviderHttpError, safeErrorType, stripKeywords, TruncatedOutputError, type Fetch, type ProviderAdapter, type ProviderConfig } from './types';

/**
 * Google Gemini — generateContent REST API. Structured output via responseMimeType
 * application/json + responseSchema (Gemini's OpenAPI-subset schema). The API key goes in the
 * x-goog-api-key header, never in the URL.
 */

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** Gemini's schema dialect: upper-case types, no additionalProperties / pattern / length limits. */
export function toGeminiSchema(schema: unknown): unknown {
  const stripped = stripKeywords(schema, ['additionalProperties', 'pattern', 'maxLength', 'minLength', 'minItems', 'maxItems']);
  const upper = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(upper);
    if (s && typeof s === 'object') {
      return Object.fromEntries(
        Object.entries(s as Record<string, unknown>).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toUpperCase() : k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, upper(pv)])) : upper(v)]),
      );
    }
    return s;
  };
  return upper(stripped);
}

export function createGeminiAdapter(cfg: ProviderConfig, http: Fetch = defaultFetch): ProviderAdapter {
  const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  return {
    id: 'gemini',
    displayName: 'Gemini (Google)',
    model: cfg.model,
    async generate(req) {
      const res = await http(`${base}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey ?? '' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
          // Thinking models spend output tokens on internal reasoning before the answer; 500 tokens was
          // not enough (observed live: 477 thinking tokens, then a cut-off plan). The plan itself is small.
          generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.schema), maxOutputTokens: 4096 },
        }),
      });
      if (!res.ok) throw new ProviderHttpError('Gemini', res.status, await safeErrorType(res));
      const body = (await res.json()) as GenerateContentResponse;
      // Blocked or empty candidates are not an outage: return nothing and let the parser record EMPTY_RESPONSE.
      if (body.promptFeedback?.blockReason) return '';
      const c = body.candidates?.[0];
      if (c?.finishReason === 'MAX_TOKENS') throw new TruncatedOutputError('Gemini', 'finishReason MAX_TOKENS');
      // Thought summaries (if a model returns them) are not the plan.
      return (c?.content?.parts ?? []).filter((p) => !(p as { thought?: boolean }).thought).map((p) => p.text ?? '').join('');
    },
  };
}
