import crypto from 'node:crypto';
import { isDatabaseAvailable, getPool } from '../config/database';
import { logger } from '../utils/logger';
import type { ReportRecord } from '../types';

export interface ReportStore {
  init(): Promise<void>;
  save(input: { runId: string; title: string; content: string; format?: 'md' | 'json' }): Promise<ReportRecord>;
  getByRun(runId: string): Promise<ReportRecord | null>;
  close(): Promise<void>;
  readonly mode: 'postgres' | 'memory';
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ─────────────────────────── PostgreSQL ─────────────────────────── */

class PgReportStore implements ReportStore {
  readonly mode = 'postgres' as const;

  async init(): Promise<void> {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS reports (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        format     TEXT NOT NULL DEFAULT 'md',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_reports_run ON reports(run_id);
    `);
  }

  private static rowToReport(row: Record<string, unknown>): ReportRecord {
    return {
      id: row.id as string,
      runId: row.run_id as string,
      title: row.title as string,
      content: row.content as string,
      format: (row.format as 'md' | 'json') ?? 'md',
      createdAt: new Date(row.created_at as Date).toISOString(),
    };
  }

  async save(input: {
    runId: string;
    title: string;
    content: string;
    format?: 'md' | 'json';
  }): Promise<ReportRecord> {
    const id = uuid();
    const { rows } = await getPool().query(
      `INSERT INTO reports (id, run_id, title, content, format)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.runId, input.title, input.content, input.format ?? 'md'],
    );
    return PgReportStore.rowToReport(rows[0]);
  }

  async getByRun(runId: string): Promise<ReportRecord | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM reports WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1',
      [runId],
    );
    return rows[0] ? PgReportStore.rowToReport(rows[0]) : null;
  }

  async close(): Promise<void> {
    /* pool lifetime is owned by config/database.ts */
  }
}

/* ─────────────────────────── In-memory ──────────────────────────── */

class MemoryReportStore implements ReportStore {
  readonly mode = 'memory' as const;
  private reports = new Map<string, ReportRecord>();

  async init(): Promise<void> {
    /* nothing to bootstrap */
  }

  async save(input: {
    runId: string;
    title: string;
    content: string;
    format?: 'md' | 'json';
  }): Promise<ReportRecord> {
    const record: ReportRecord = {
      id: uuid(),
      runId: input.runId,
      title: input.title,
      content: input.content,
      format: input.format ?? 'md',
      createdAt: now(),
    };
    this.reports.set(record.id, record);
    return record;
  }

  async getByRun(runId: string): Promise<ReportRecord | null> {
    const matches = [...this.reports.values()].filter((r) => r.runId === runId);
    return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async close(): Promise<void> {
    this.reports.clear();
  }
}

/* ─────────────────────────── Singleton ──────────────────────────── */

let store: ReportStore | null = null;

export async function initReportStore(): Promise<ReportStore> {
  store = isDatabaseAvailable() ? new PgReportStore() : new MemoryReportStore();
  await store.init();
  logger.info(`Report store ready (${store.mode})`);
  return store;
}

export function reportStore(): ReportStore {
  if (!store) {
    throw new Error('Report store has not been initialised - call initReportStore() first');
  }
  return store;
}
