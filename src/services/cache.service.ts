import { kvStore } from '../config/kv';

/**
 * Thin typed helpers over the KV store, used for the search cache and other
 * short-lived data. Works identically on Redis and the in-memory fallback.
 */

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await kvStore().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await kvStore().set(key, JSON.stringify(value), ttlSeconds);
  } catch {
    /* cache is best-effort */
  }
}
