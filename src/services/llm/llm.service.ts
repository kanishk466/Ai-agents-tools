import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { type LlmMessage, type LlmProvider, type LlmResult } from './llm.types';
import { GeminiProvider } from './gemini.provider';
import { GroqProvider } from './groq.provider';
import { LocalProvider } from './local.provider';

/**
 * LLM router.
 *
 * Order: Gemini (primary, free) → Groq (fallback, free) → local offline actor.
 * A 429/5xx/timeouts on one provider transparently falls through to the next,
 * so the caller never sees the switch.
 */
const providers: LlmProvider[] = [new GeminiProvider(), new GroqProvider(), new LocalProvider()];

/** Providers that will actually be attempted for cloud inference. */
export function activeProviders(): string[] {
  if (!env.useLlm) return ['local'];
  return providers.filter((p) => p.available()).map((p) => p.name);
}

export async function chat(
  messages: LlmMessage[],
  opts?: { signal?: AbortSignal },
): Promise<LlmResult> {
  const candidates = env.useLlm
    ? providers.filter((p) => p.available())
    : [providers[providers.length - 1]]; // local only

  let lastError: unknown = null;

  for (const provider of candidates) {
    try {
      return await provider.chat(messages, opts);
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`LLM ${provider.name} failed${status ? ` (${status})` : ''}: ${reason}`);
      // Fall through to the next provider.
    }
  }

  // Every provider failed (should be impossible - local never throws).
  throw lastError instanceof Error ? lastError : new Error('All LLM providers failed');
}

export function llmHealth(): Record<string, boolean> {
  return {
    gemini: env.hasGemini,
    groq: env.hasGroq,
    offlineActor: true,
    mode: env.llmMode,
  } as unknown as Record<string, boolean>;
}
