import type { LLMProvider, LLMRequest, LLMStats } from './types';

export interface GatewayOptions {
  maxCallsPerMinute: number;
  maxConcurrent: number;
  dailyTokenBudget: number;
  timeoutMs: number;
  priceInPerM?: number;
  priceOutPerM?: number;
}

/**
 * All LLM traffic goes through here: rate limit, concurrency, daily token budget and stats.
 * Without capacity `available` is false and agents continue on reflexes —
 * so the aquarium keeps running even when the budget is spent.
 */
export class LLMGateway {
  enabled = true;
  private recent: number[] = [];
  private inFlight = 0;
  private calls = 0;
  private errors = 0;
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private outputTokens = 0;
  private lastError: string | null = null;
  private budgetDay = new Date().toDateString();
  private tokensToday = 0;

  constructor(
    readonly provider: LLMProvider,
    private opts: GatewayOptions,
  ) {}

  get available(): boolean {
    this.rollDay();
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    return (
      this.enabled &&
      this.inFlight < this.opts.maxConcurrent &&
      this.recent.length < this.opts.maxCallsPerMinute &&
      this.tokensToday < this.opts.dailyTokenBudget
    );
  }

  async request(req: LLMRequest): Promise<string> {
    this.recent.push(Date.now());
    this.inFlight++;
    this.calls++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.timeoutMs);
    try {
      const res = await this.provider.complete(req, abort.signal);
      this.inputTokens += res.inputTokens;
      this.cacheReadTokens += res.cacheReadTokens ?? 0;
      this.outputTokens += res.outputTokens;
      this.tokensToday += res.inputTokens + res.outputTokens;
      return res.text;
    } catch (err) {
      this.errors++;
      this.lastError = abort.signal.aborted ? 'Timeout' : (err as Error).message.slice(0, 200);
      console.warn(`[llm] ${this.lastError}`);
      throw err;
    } finally {
      clearTimeout(timer);
      this.inFlight--;
    }
  }

  stats(): LLMStats {
    const { priceInPerM, priceOutPerM } = this.opts;
    const costUsd =
      priceInPerM != null && priceOutPerM != null
        ? // Cached input is billed at ~10% of the price.
          ((this.inputTokens - this.cacheReadTokens * 0.9) * priceInPerM + this.outputTokens * priceOutPerM) / 1_000_000
        : null;
    return {
      provider: this.provider.name,
      model: this.provider.model,
      enabled: this.enabled,
      calls: this.calls,
      errors: this.errors,
      inFlight: this.inFlight,
      inputTokens: this.inputTokens,
      cacheReadTokens: this.cacheReadTokens,
      outputTokens: this.outputTokens,
      costUsd,
      lastError: this.lastError,
      budgetLeft: Math.max(0, this.opts.dailyTokenBudget - this.tokensToday),
    };
  }

  private rollDay() {
    const today = new Date().toDateString();
    if (today !== this.budgetDay) {
      this.budgetDay = today;
      this.tokensToday = 0;
    }
  }
}
