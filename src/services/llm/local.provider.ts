import { extractFirstUrl } from '../../utils/text';
import { type LlmMessage, type LlmProvider, type LlmResult } from './llm.types';

/**
 * Offline ReAct actor.
 *
 * Used when no LLM key is set (AGENT_MODE=local) or every cloud provider is
 * down. It is a deterministic, rule-based stand-in for an LLM: it reads the
 * transcript, picks a tool, and emits the same Thought/Action/Answer protocol
 * the cloud models produce. This keeps the entire pipeline runnable with zero
 * API keys — tools like web_search still hit the real (keyless) DuckDuckGo.
 */
export class LocalProvider implements LlmProvider {
  readonly name = 'local';

  available(): boolean {
    return true; // always available - it is the last-resort fallback
  }

  async chat(messages: LlmMessage[]): Promise<LlmResult> {
    const text = this.act(messages);
    return {
      text,
      provider: this.name,
      model: 'offline-rule-based',
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    };
  }

  private act(messages: LlmMessage[]): string {
    const userMsgs = messages.filter((m) => m.role === 'user');
    const observations = userMsgs
      .filter((m) => m.content.startsWith('Observation:'))
      .map((m) => m.content.replace(/^Observation:\s*/i, '').trim());
    const query = [...userMsgs].reverse().find((m) => !m.content.startsWith('Observation:'))?.content ?? '';

    /* Already acted once - either fire a second search (compare) or answer. */
    if (observations.length > 0) {
      const terms = compareTerms(query);
      if (terms.length >= 2 && observations.length < 2) {
        return [
          `Thought: I have the first result; now I search for "${terms[1]}" to complete the comparison.`,
          `Action: web_search`,
          `Action Input: ${JSON.stringify({ query: terms[1] })}`,
        ].join('\n');
      }
      if (terms.length >= 2 && observations.length >= 2) {
        return [
          'Thought: Both results are in, so I can present the comparison.',
          `Answer: **${terms[0]}** → ${summarize(observations[0])}`,
          ``,
          `**${terms[1]}** → ${summarize(observations[1])}`,
          ``,
          `_Offline mode: the two summaries above are the raw findings. Add a GEMINI_API_KEY for a fully reasoned side-by-side comparison._`,
        ].join('\n');
      }
      return [
        'Thought: I have enough information to answer.',
        `Answer: Here is what I found:\n\n${summarize(observations[0])}`,
        ``,
        `_Offline mode: add a GEMINI_API_KEY for a fully reasoned answer._`,
      ].join('\n');
    }

    /* First turn - decide which tool (if any) to call. */
    const url = extractFirstUrl(query);
    if (url) {
      return [
        'Thought: The user shared a URL, so I should read its contents.',
        `Action: scrape_url`,
        `Action Input: ${JSON.stringify({ url })}`,
      ].join('\n');
    }

    const math = mathExpression(query);
    if (math) {
      return [
        'Thought: This is an arithmetic problem, so I will compute it precisely.',
        `Action: calculator`,
        `Action Input: ${JSON.stringify({ expression: math })}`,
      ].join('\n');
    }

    const terms = compareTerms(query);
    if (terms.length >= 2) {
      return [
        `Thought: This is a comparison, so I start by searching for "${terms[0]}".`,
        `Action: web_search`,
        `Action Input: ${JSON.stringify({ query: terms[0] })}`,
      ].join('\n');
    }

    if (SEARCH_INTENT.test(query)) {
      return [
        'Thought: This needs current information from the web, so I will search.',
        `Action: web_search`,
        `Action Input: ${JSON.stringify({ query: cleanQuery(query) })}`,
      ].join('\n');
    }

    /* No tool needed - answer directly. */
    return [
      'Thought: I can answer this directly without any tools.',
      `Answer: I am running in offline mode without an LLM, so I can only help with searches, arithmetic, and scraping. ` +
        `Set GEMINI_API_KEY (or GROQ_API_KEY) for full reasoning. Your query was: "${query}".`,
    ].join('\n');
  }
}

/* ─────────────────────────── helpers ──────────────────────────── */

const SEARCH_INTENT =
  /\b(search|look ?up|latest|current|today|news|price|cost|rate|stock|weather|forecast|who|what|when|where|why|how many|meaning|definition|score|release)\b/i;

function cleanQuery(query: string): string {
  return query
    .replace(/^(please\s+)?(search( for)?|find|look up|tell me about|what is|who is|when is|where is)\s+/i, '')
    .replace(/[?.!]+$/g, '')
    .trim();
}

/** Splits "a vs b" / "a versus b" / "a, b" into comparison terms. */
function compareTerms(query: string): string[] {
  if (!/\b(vs\.?|versus)\b|,/i.test(query)) return [];
  return query
    .split(/\s+(?:vs\.?|versus)\s+|,/i)
    .map((term) => term.replace(/^(compare|price of)\s+/i, '').replace(/[?.!]+$/g, '').trim())
    .filter((term) => term.length > 0)
    .slice(0, 2);
}

/** Extracts a plausible arithmetic expression, or null. */
function mathExpression(query: string): string | null {
  const cleaned = query
    .replace(/^(what\s+is|calculate|compute|solve|evaluate)\s+/i, '')
    .replace(/[?=]+$/g, '')
    .trim();
  if (!/^[\d\s+\-*/().^%]+$/.test(cleaned)) return null;
  if (!/[+\-*/^%]/.test(cleaned)) return null; // a bare number needs no calculator
  return cleaned;
}

function summarize(observation: string): string {
  const text = observation.replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
