import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

/** Per-1M-token prices (USD) of known models — used for cost estimates when env prices aren't set. */
export const ANTHROPIC_PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'claude';
  private client: Anthropic;

  constructor(
    apiKey: string | undefined,
    readonly model: string,
    private effort: Effort = 'low',
  ) {
    // Without an explicit key the SDK resolves credentials from the environment (ANTHROPIC_API_KEY / `ant auth login` profile).
    this.client = new Anthropic(apiKey ? { apiKey, maxRetries: 1 } : { maxRetries: 1 });
  }

  async complete(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        // Thinking tokens count toward this limit; leave headroom even for short decisions.
        max_tokens: req.maxOutputTokens ?? 4000,
        // The system prompt is fixed per agent → cached, ~90% cheaper on later calls.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: this.effort, format: { type: 'json_schema', schema: req.schema } },
        // If a safety classifier declines, the server falls back to a suitable model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );

    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined (${response.stop_details?.category ?? 'no category'})`);
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text) throw new Error(`Empty Claude reply (${response.stop_reason})`);

    const u = response.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return {
      text,
      inputTokens: u.input_tokens + cacheRead + cacheWrite,
      cacheReadTokens: cacheRead,
      outputTokens: u.output_tokens,
    };
  }
}
