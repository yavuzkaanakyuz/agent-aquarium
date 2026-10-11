/** Provider-agnostic LLM call. Claude, Gemini, OpenAI-compatible and the offline mock implement the same interface. */
export interface LLMRequest {
  system: string;
  user: string;
  /** JSON Schema the reply must follow. */
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Used only by the mock provider: structured context without parsing text. */
  meta?: unknown;
}

export interface LLMResponse {
  text: string;
  inputTokens: number; // total input including cache reads
  cacheReadTokens?: number;
  outputTokens: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse>;
}

export type { LLMStats } from '../../shared/protocol';
