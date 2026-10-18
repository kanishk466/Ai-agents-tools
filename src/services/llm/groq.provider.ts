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

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Groq chat provider (OpenAI-compatible REST, free tier). Used as the fallback
 * when Gemini rate-limits (429) or errors.
 */
export class GroqProvider implements LlmProvider {
  readonly name = 'groq';

  available(): boolean {
    return env.hasGroq;
  }

  async chat(messages: LlmMessage[], opts?: { signal?: AbortSignal }): Promise<LlmResult> {
    const model = env.GROQ_MODEL;

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1024,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: callSignal(opts?.signal, 30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`Groq ${response.status}: ${detail.slice(0, 200)}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = (json.choices?.[0]?.message?.content ?? '').trim();
    const usage = json.usage?.prompt_tokens
      ? {
          inputTokens: json.usage.prompt_tokens ?? 0,
          outputTokens: json.usage.completion_tokens ?? 0,
        }
      : fallbackUsage(messages.map((m) => m.content).join('\n'), text);

    logger.debug(`groq ok (${usage.inputTokens}in/${usage.outputTokens}out)`);
    return {
      text,
      provider: this.name,
      model,
      usage,
      costUsd: priceFor(model, usage),
    };
  }
}
