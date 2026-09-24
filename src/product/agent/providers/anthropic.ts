import { defaultFetch, ProviderHttpError, safeErrorType, TruncatedOutputError, type Fetch, type ProviderAdapter, type ProviderConfig } from './types';

/**
 * Anthropic (Claude) — Messages API. Structured output via a forced tool call whose input_schema is
 * the plan schema; the tool input is the plan.
 */

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';

interface MessagesResponse {
  content?: { type: string; name?: string; input?: unknown; text?: string }[];
  stop_reason?: string;
}

export function createAnthropicAdapter(cfg: ProviderConfig, http: Fetch = defaultFetch): ProviderAdapter {
  const base = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    id: 'anthropic',
    displayName: 'Claude (Anthropic)',
    model: cfg.model,
    async generate(req) {
      const res = await http(`${base}/v1/messages`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1024,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
          tools: [{ name: req.toolName, description: 'Propose the single next investigation tool call. Jagr validates it before anything runs.', input_schema: req.schema }],
          tool_choice: { type: 'tool', name: req.toolName },
        }),
      });
      if (!res.ok) throw new ProviderHttpError('Anthropic', res.status, await safeErrorType(res));
      const body = (await res.json()) as MessagesResponse;
      if (body.stop_reason === 'max_tokens') throw new TruncatedOutputError('Claude', 'stop_reason max_tokens');
      const call = body.content?.find((c) => c.type === 'tool_use' && c.name === req.toolName);
      if (call) return JSON.stringify(call.input ?? null);
      // No tool call (e.g. a refusal): hand back the text and let the shared parser reject it.
      return body.content?.find((c) => c.type === 'text')?.text ?? '';
    },
  };
}
