import 'dotenv/config';
import { z } from 'zod';

/** Optional string that treats "" / whitespace as "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * auto  -> cloud LLM/search when keys are present, offline actor otherwise
   * cloud -> require an LLM key, never fall back to the offline actor
   * local -> never call external LLM/search APIs
   */
  AGENT_MODE: z.enum(['auto', 'cloud', 'local']).default('auto'),

  /* LLM providers */
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  /* Search */
  TAVILY_API_KEY: optionalString,

  /* Storage */
  DATABASE_URL: optionalString,
  REDIS_URL: optionalString,

  /* Guardrails / tuning */
  MAX_ITERATIONS: z.coerce.number().int().positive().default(8),
  MAX_COST_USD: z.coerce.number().positive().default(0.5),
  TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CODE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  TOOL_RESULT_MAX_CHARS: z.coerce.number().int().positive().default(1500),
  DAILY_LIMIT_PER_IP: z.coerce.number().int().positive().default(20),
  QUERY_MAX_CHARS: z.coerce.number().int().positive().default(500),
  DAILY_COST_CAP_USD: z.coerce.number().positive().default(5),

  /* Search cache TTL (seconds) */
  SEARCH_CACHE_TTL: z.coerce.number().int().positive().default(3600),
});

const parsed = schema.parse(process.env);

const hasGemini = Boolean(parsed.GEMINI_API_KEY);
const hasGroq = Boolean(parsed.GROQ_API_KEY);
const hasAnyLlm = hasGemini || hasGroq;
const hasTavily = Boolean(parsed.TAVILY_API_KEY);

if (parsed.AGENT_MODE === 'cloud' && !hasAnyLlm) {
  throw new Error(
    'AGENT_MODE=cloud requires GEMINI_API_KEY or GROQ_API_KEY. ' +
      'Set one, or use AGENT_MODE=auto / local.',
  );
}

/** Cloud LLM enabled? (local mode forces the offline actor even if keys exist) */
const useLlm = parsed.AGENT_MODE !== 'local' && hasAnyLlm;
/** Cloud web search (Tavily) enabled? */
const useTavily = parsed.AGENT_MODE !== 'local' && hasTavily;

if (!useLlm && hasAnyLlm && parsed.AGENT_MODE === 'local') {
  process.emitWarning('AGENT_MODE=local - ignoring LLM keys and using the offline actor.');
}

/** Approx USD per 1M tokens, used by the cost-tracker guardrail. */
export const LLM_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
};

export const env = {
  ...parsed,
  /** Effective runtime mode for the LLM chain. */
  llmMode: useLlm ? ('cloud' as const) : ('local' as const),
  searchMode: useTavily ? ('tavily' as const) : ('duckduckgo' as const),
  useLlm,
  useTavily,
  hasGemini,
  hasGroq,
};

export type Env = typeof env;
