import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  constructor(
    private apiKey: string,
    readonly model: string,
    private thinkingLevel?: string,
  ) {}

  async complete(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.9,
      maxOutputTokens: req.maxOutputTokens ?? 400,
      responseMimeType: 'application/json',
      responseJsonSchema: req.schema,
    };
    if (this.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: this.thinkingLevel };

    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message ?? res.statusText}`);

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Empty Gemini reply (${data.candidates?.[0]?.finishReason ?? 'unknown'})`);
    const u = data.usageMetadata ?? {};
    return {
      text,
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    };
  }
}
