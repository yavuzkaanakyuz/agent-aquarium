import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

interface ChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; metadata?: { raw?: string } };
}

/**
 * Any OpenAI-compatible /chat/completions endpoint: OpenAI, OpenRouter, Groq, local Ollama/LM Studio, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private openRouter: boolean;

  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl = 'https://api.openai.com/v1',
  ) {
    this.openRouter = baseUrl.includes('openrouter.ai');
    this.name = this.openRouter ? 'openrouter' : 'openai';
  }

  async complete(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    // On OpenRouter, mark the system prompt cacheable for Claude models (it's fixed per agent).
    const cacheable = this.openRouter && this.model.startsWith('anthropic/');
    const system = cacheable
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...(this.openRouter ? { 'x-title': 'Agent Aquarium' } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        // Thinking models spend the output limit on reasoning too; leave headroom even for short JSON.
        max_tokens: req.maxOutputTokens ?? 2000,
        ...(cacheable ? {} : { temperature: req.temperature ?? 0.9 }),
        response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: req.schema } },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok || data.error) {
      const detail = data.error?.metadata?.raw ?? data.error?.message ?? res.statusText;
      throw new Error(`${this.model} ${res.status}: ${String(detail).slice(0, 200)}`);
    }
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error(`Empty reply (${data.choices?.[0]?.finish_reason ?? 'unknown'})`);
    return {
      text,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}
