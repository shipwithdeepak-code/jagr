import { ProviderHttpError, safeErrorType, stripKeywords, TruncatedOutputError, type Fetch, type ProviderAdapter, type ProviderConfig, type StructuredMode } from './types.js';

/**
 * OpenAI and OpenAI-compatible endpoints — Chat Completions API.
 *
 * - openai: response_format json_schema (strict) by default.
 * - openai-compatible (OpenRouter, Groq, Mistral, DeepSeek, xAI, local Ollama, …): same wire format,
 *   but support for structured output varies, so the mode is configurable:
 *     json_schema — strict JSON Schema (when the endpoint supports it)
 *     json_object — "JSON mode"; the schema is described in the prompt
 *     prompt      — no response_format; the prompt asks for JSON only
 *   In every mode the shared schema is enforced locally.
 */

interface ChatResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
}

const JSON_ONLY = (schema: Record<string, unknown>) =>
  `\n\nReturn ONLY one JSON object, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`;

/** Some compatible models wrap JSON in a markdown fence. Unwrapping it is transport normalization, not repair. */
export function unwrapFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : text;
}

export function createOpenAIAdapter(cfg: ProviderConfig, http: Fetch, flavour: 'openai' | 'openai-compatible' = 'openai'): ProviderAdapter {
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const mode: StructuredMode = cfg.structured ?? (flavour === 'openai' ? 'json_schema' : 'json_object');
  return {
    id: flavour,
    displayName: flavour === 'openai' ? 'OpenAI' : `OpenAI-compatible (${safeHost(base)})`,
    model: cfg.model,
    async generate(req) {
      const response_format =
        mode === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: req.toolName, strict: true, schema: stripKeywords(req.schema, ['pattern', 'maxLength', 'minLength', 'minItems', 'maxItems']) } }
          : mode === 'json_object'
            ? { type: 'json_object' }
            : undefined;
      const user = mode === 'json_schema' ? req.prompt : req.prompt + JSON_ONLY(req.schema);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`; // local endpoints (e.g. Ollama) may need none
      const res = await http(`${base}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: user },
          ],
          ...(response_format ? { response_format } : {}),
        }),
      });
      if (!res.ok) throw new ProviderHttpError(flavour === 'openai' ? 'OpenAI' : 'OpenAI-compatible endpoint', res.status, await safeErrorType(res));
      const body = (await res.json()) as ChatResponse;
      if (body.choices?.[0]?.finish_reason === 'length') throw new TruncatedOutputError(flavour === 'openai' ? 'OpenAI' : 'OpenAI-compatible endpoint', 'finish_reason length');
      const msg = body.choices?.[0]?.message;
      if (!msg || msg.refusal) return ''; // a refusal is not a plan
      return unwrapFence(msg.content ?? '');
    },
  };
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'custom endpoint';
  }
}
