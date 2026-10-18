/**
 * Small text helpers shared by the tools, guardrails and finalizer.
 */

/** Cut a string to `max` characters, appending an ellipsis marker. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Cheap token estimate (~4 chars/token) used when a provider omits usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Patterns that must never reach a user or an LLM context. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bAIza[A-Za-z0-9_-]{30,}\b/g, // Google / Gemini keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access keys
  /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/g, // JWT-ish
];

/**
 * Output sanitizer (guardrail). Strips anything that looks like a credential
 * before content is shown to the user or fed back into the model.
 */
export function sanitizeOutput(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** URL-safe slug for report filenames. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

/** Pull the first http(s) URL out of a string (used by the scraper tool). */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0] : null;
}

/** Collapse whitespace runs so tool output stays token-efficient. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
