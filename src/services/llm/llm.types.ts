import { LLM_PRICING } from '../../config/env';
import { estimateTokens } from '../../utils/text';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  usage: LlmUsage;
  costUsd: number;
}

export interface LlmProvider {
  readonly name: string;
  available(): boolean;
  chat(messages: LlmMessage[], opts?: { signal?: AbortSignal }): Promise<LlmResult>;
}

/** USD cost of one completion, using the approximate pricing table. */
export function priceFor(model: string, usage: LlmUsage): number {
  const rate = LLM_PRICING[model] ?? { input: 0.2, output: 0.6 };
  return (usage.inputTokens / 1_000_000) * rate.input + (usage.outputTokens / 1_000_000) * rate.output;
}

/**
 * Combines an outer (budget) signal with a per-call timeout so a single slow
 * LLM call cannot eat the whole run budget.
 */
export function callSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/** Fallback token estimate for providers that omit usage metadata. */
export function fallbackUsage(prompt: string, completion: string): LlmUsage {
  return { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(completion) };
}
