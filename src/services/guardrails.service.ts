import { env } from '../config/env';
import { kvStore } from '../config/kv';
import { sanitizeOutput } from '../utils/text';

/**
 * Guardrails layer — the safety net applied at the API, orchestration and tool
 * boundaries. Centralised here so nothing gets forgotten at a call site.
 */

/** Per-identity daily request cap (keyed by IP or session). */
export interface LimitCheck {
  allowed: boolean;
  used: number;
  limit: number;
  resetInSeconds: number;
}

export async function checkDailyLimit(identity: string): Promise<LimitCheck> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `ratelimit:${identity}:${day}`;
  const used = await kvStore().incr(key, 86_400);
  const resetInSeconds = await kvStore().ttl(key);
  return {
    allowed: used <= env.DAILY_LIMIT_PER_IP,
    used,
    limit: env.DAILY_LIMIT_PER_IP,
    resetInSeconds: resetInSeconds > 0 ? resetInSeconds : 86_400,
  };
}

/** Per-identity daily spend cap, checked before a run starts. */
export async function checkSpendLimit(identity: string): Promise<{ allowed: boolean; spent: number; cap: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const raw = await kvStore().get(`cost:${identity}:${day}`);
  const spent = raw ? Number(raw) || 0 : 0;
  return { allowed: spent < env.DAILY_COST_CAP_USD, spent, cap: env.DAILY_COST_CAP_USD };
}

/** Adds the cost of a completed run to the daily spend counter. */
export async function recordSpend(identity: string, usd: number): Promise<void> {
  if (usd <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `cost:${identity}:${day}`;
  const raw = await kvStore().get(key);
  const next = (raw ? Number(raw) || 0 : 0) + usd;
  await kvStore().set(key, String(next), 86_400);
}

/** Output sanitizer — strips credentials before anything reaches the user. */
export function sanitize(text: string): string {
  return sanitizeOutput(text);
}

/** Patterns the code-execution tool must refuse (shared policy). */
export const FORBIDDEN_CODE_PATTERNS = [
  'require(',
  'import ',
  'process',
  'child_process',
  'eval(',
  'Function(',
  '__proto__',
] as const;
