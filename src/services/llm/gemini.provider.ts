import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import {
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  callSignal,
  fallbackUsage,
  priceFor,
} from './llm.types';

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * Google Gemini chat provider (free tier). Uses the REST API directly so we
 * don't need the heavyweight SDK. Messages follow the classic chat shape and
 * the system prompt is passed via `systemInstruction`.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  available(): boolean {
    return env.hasGemini;
  }

  async chat(messages: LlmMessage[], opts?: { signal?: AbortSignal }): Promise<LlmResult> {
    const model = env.GEMINI_MODEL;
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const response = await fetch(`${ENDPOINT(model)}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: callSignal(opts?.signal, 30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`Gemini ${response.status}: ${detail.slice(0, 200)}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const text = (json.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    const meta = json.usageMetadata ?? {};
    const usage =
      meta.promptTokenCount !== undefined && meta.candidatesTokenCount !== undefined
        ? { inputTokens: meta.promptTokenCount, outputTokens: meta.candidatesTokenCount }
        : fallbackUsage(
            messages.map((m) => m.content).join('\n'),
            text,
          );

    logger.debug(`gemini ok (${usage.inputTokens}in/${usage.outputTokens}out)`);
    return {
      text,
      provider: this.name,
      model,
      usage,
      costUsd: priceFor(model, usage),
    };
  }
}
