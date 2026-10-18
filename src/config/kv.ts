import { env } from './env';
import { logger } from '../utils/logger';

/**
 * A tiny key-value abstraction shared by the search cache, session memory,
 * the rate limiter and the cost tracker.
 *
 *  - Redis reachable  -> durable, shared, TTL-aware
 *  - Redis unreachable -> in-process Map with per-key expiry
 *
 * Both drivers expose the same API, so higher-level services never care
 * which one they got.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Atomically increment a counter, applying a TTL the first time it is created. */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  del(key: string): Promise<void>;
  /** Seconds until expiry: -1 = no TTL, -2 = key missing. */
  ttl(key: string): Promise<number>;
  readonly mode: 'redis' | 'memory';
}

/* ─────────────────────────── In-memory ──────────────────────────── */

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

class MemoryKv implements KvStore {
  readonly mode = 'memory' as const;
  private store = new Map<string, MemoryEntry>();

  private live(key: string): MemoryEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const entry = this.live(key);
    const next = (entry ? Number.parseInt(entry.value, 10) || 0 : 0) + 1;
    if (!entry && ttlSeconds) {
      this.store.set(key, { value: String(next), expiresAt: Date.now() + ttlSeconds * 1000 });
    } else if (entry) {
      entry.value = String(next);
    } else {
      this.store.set(key, { value: String(next), expiresAt: null });
    }
    return next;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }
}

/* ──────────────────────────── Redis ────────────────────────────── */

class RedisKv implements KvStore {
  readonly mode = 'redis' as const;
  constructor(private client: import('ioredis').default) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
    else await this.client.set(key, value);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds);
    return value;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async disconnect(): Promise<void> {
    this.client.disconnect();
  }
}

/** Probes Redis; returns null when it is unreachable. */
async function tryRedis(url: string): Promise<import('ioredis').default | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // never retry - we fall back to in-memory
    });
    client.on('error', () => undefined); // the probe expects failure - keep it quiet
    await client.connect();
    await client.ping();
    return client;
  } catch {
    return null;
  }
}

let kv: KvStore | null = null;

export async function initKv(): Promise<KvStore> {
  if (env.REDIS_URL) {
    const client = await tryRedis(env.REDIS_URL);
    if (client) {
      kv = new RedisKv(client);
      logger.info('KV store: Redis');
      return kv;
    }
    logger.warn('Redis unreachable - falling back to in-memory KV store');
  } else {
    logger.info('REDIS_URL not set - using in-memory KV store');
  }
  kv = new MemoryKv();
  return kv;
}

export function kvStore(): KvStore {
  if (!kv) {
    throw new Error('KV store has not been initialised - call initKv() first');
  }
  return kv;
}

export async function closeKv(): Promise<void> {
  if (kv instanceof RedisKv) await kv.disconnect().catch(() => undefined);
  kv = null;
}
