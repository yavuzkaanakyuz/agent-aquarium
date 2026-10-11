import { LLMGateway } from './gateway';
import { ANTHROPIC_PRICES, AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { MockProvider } from './providers/mock';
import { OpenAICompatibleProvider } from './providers/openai';
import type { LLMProvider } from './types';

const num = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : fallback);
const optNum = (v: string | undefined) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Picks the provider from .env: LLM_PROVIDER if set, otherwise whichever key exists, otherwise mock. */
function createProvider(env: NodeJS.ProcessEnv): LLMProvider {
  const choice =
    env.LLM_PROVIDER ??
    (env.ANTHROPIC_API_KEY ? 'claude' : env.GEMINI_API_KEY ? 'gemini' : env.OPENAI_API_KEY ? 'openai' : 'mock');
  switch (choice) {
    case 'claude':
      return new AnthropicProvider(
        env.ANTHROPIC_API_KEY,
        env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
        (env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'low',
      );
    case 'gemini':
      if (!env.GEMINI_API_KEY) throw new Error('LLM_PROVIDER=gemini but GEMINI_API_KEY is not set');
      return new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite', env.GEMINI_THINKING_LEVEL);
    case 'openai':
      return new OpenAICompatibleProvider(env.OPENAI_API_KEY ?? '', env.OPENAI_MODEL ?? 'gpt-4o-mini', env.OPENAI_BASE_URL);
    case 'mock':
      return new MockProvider(num(env.MOCK_LATENCY_MS, 250));
    default:
      throw new Error(`Bilinmeyen LLM_PROVIDER: ${choice}`);
  }
}

export function createGateway(env = process.env): LLMGateway {
  const provider = createProvider(env);
  const known = provider.name === 'claude' ? ANTHROPIC_PRICES[provider.model] : undefined;
  return new LLMGateway(provider, {
    maxCallsPerMinute: num(env.LLM_MAX_CALLS_PER_MIN, 30),
    maxConcurrent: num(env.LLM_MAX_CONCURRENT, 4),
    dailyTokenBudget: num(env.LLM_DAILY_TOKEN_BUDGET, 2_000_000),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 15_000),
    priceInPerM: optNum(env.LLM_PRICE_IN_PER_M) ?? known?.in,
    priceOutPerM: optNum(env.LLM_PRICE_OUT_PER_M) ?? known?.out,
  });
}

/** Minimum simulation ticks between two LLM decisions of the same agent. */
export const minThinkTicks = () => num(process.env.LLM_MIN_THINK_TICKS, 150);
