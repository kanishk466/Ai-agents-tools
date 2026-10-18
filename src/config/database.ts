import { Pool } from 'pg';
import { env } from './env';
import { logger } from '../utils/logger';

let pool: Pool | null = null;
let available = false;

/**
 * Opens the PostgreSQL pool when DATABASE_URL is configured.
 * Returns false when Postgres is unavailable so callers can fall back
 * to the in-memory stores.
 */
export async function initDatabase(): Promise<boolean> {
  if (!env.DATABASE_URL) {
    logger.info('DATABASE_URL not set - using in-memory stores');
    return false;
  }

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => logger.error(`PostgreSQL pool error: ${err.message}`));

  try {
    await pool.query('SELECT 1');
    available = true;
    logger.info('PostgreSQL connected');
  } catch (err) {
    const error = err as Error & { code?: string };
    const detail = error.message || error.code || String(err);
    logger.warn(`PostgreSQL unreachable (${detail}) - using in-memory stores`);
    pool = null;
    available = false;
  }

  return available;
}

export function getPool(): Pool {
  if (!available || !pool) {
    throw new Error('PostgreSQL is not available');
  }
  return pool;
}

export function isDatabaseAvailable(): boolean {
  return available;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
    available = false;
  }
}
