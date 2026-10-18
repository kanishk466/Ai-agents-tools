import crypto from 'node:crypto';
import { isDatabaseAvailable, getPool } from '../config/database';
import { logger } from '../utils/logger';
import type { RunRecord, RunStatus, RunStats, AgentStep, Source } from '../types';

export interface RunPatch {
  status?: RunStatus;
  answer?: string | null;
  sources?: Source[];
  steps?: AgentStep[];
  stats?: Partial<RunStats>;
  error?: string | null;
  completedAt?: string | null;
}

export interface RunStore {
  init(): Promise<void>;
  createRun(input: { runId?: string; sessionId: string; query: string }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: RunPatch): Promise<RunRecord | null>;
  listRunsBySession(sessionId: string, limit: number): Promise<RunRecord[]>;
  close(): Promise<void>;
  readonly mode: 'postgres' | 'memory';
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ─────────────────────────── PostgreSQL ─────────────────────────── */

class PgRunStore implements RunStore {
  readonly mode = 'postgres' as const;

  async init(): Promise<void> {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        query        TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        answer       TEXT,
        sources      JSONB NOT NULL DEFAULT '[]',
        steps        JSONB NOT NULL DEFAULT '[]',
        stats        JSONB NOT NULL DEFAULT '{}',
        error        TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_runs_session ON agent_runs(session_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);
    `);
  }

  private static rowToRun(row: Record<string, unknown>): RunRecord {
    return {
      runId: row.id as string,
      sessionId: row.session_id as string,
      query: row.query as string,
      status: row.status as RunStatus,
      answer: (row.answer as string | null) ?? null,
      sources: (row.sources as Source[]) ?? [],
      steps: (row.steps as AgentStep[]) ?? [],
      stats: (row.stats as Partial<RunStats>) ?? {},
      error: (row.error as string | null) ?? null,
      createdAt: new Date(row.created_at as Date).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as Date).toISOString() : null,
    };
  }

  async createRun(input: { runId?: string; sessionId: string; query: string }): Promise<RunRecord> {
    const id = input.runId ?? `run_${uuid().slice(0, 8)}`;
    const { rows } = await getPool().query(
      `INSERT INTO agent_runs (id, session_id, query)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, input.sessionId, input.query],
    );
    return PgRunStore.rowToRun(rows[0]);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const { rows } = await getPool().query('SELECT * FROM agent_runs WHERE id = $1', [runId]);
    return rows[0] ? PgRunStore.rowToRun(rows[0]) : null;
  }

  async updateRun(runId: string, patch: RunPatch): Promise<RunRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [runId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.status !== undefined) add('status', patch.status);
    if (patch.answer !== undefined) add('answer', patch.answer);
    if (patch.sources !== undefined) add('sources', JSON.stringify(patch.sources));
    if (patch.steps !== undefined) add('steps', JSON.stringify(patch.steps));
    if (patch.stats !== undefined) add('stats', JSON.stringify(patch.stats));
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.completedAt !== undefined) add('completed_at', patch.completedAt);

    if (sets.length === 0) return this.getRun(runId);

    const { rows } = await getPool().query(
      `UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    );
    return rows[0] ? PgRunStore.rowToRun(rows[0]) : null;
  }

  async listRunsBySession(sessionId: string, limit: number): Promise<RunRecord[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM agent_runs
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map(PgRunStore.rowToRun);
  }

  async close(): Promise<void> {
    /* pool lifetime is owned by config/database.ts */
  }
}

/* ─────────────────────────── In-memory ──────────────────────────── */

class MemoryRunStore implements RunStore {
  readonly mode = 'memory' as const;
  private runs = new Map<string, RunRecord>();

  async init(): Promise<void> {
    /* nothing to bootstrap */
  }

  async createRun(input: { runId?: string; sessionId: string; query: string }): Promise<RunRecord> {
    const record: RunRecord = {
      runId: input.runId ?? `run_${uuid().slice(0, 8)}`,
      sessionId: input.sessionId,
      query: input.query,
      status: 'queued',
      answer: null,
      sources: [],
      steps: [],
      stats: {},
      error: null,
      createdAt: now(),
      completedAt: null,
    };
    this.runs.set(record.runId, record);
    return record;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async updateRun(runId: string, patch: RunPatch): Promise<RunRecord | null> {
    const record = this.runs.get(runId);
    if (!record) return null;
    Object.assign(record, patch);
    return record;
  }

  async listRunsBySession(sessionId: string, limit: number): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async close(): Promise<void> {
    this.runs.clear();
  }
}

/* ─────────────────────────── Singleton ──────────────────────────── */

let store: RunStore | null = null;

export async function initRunStore(): Promise<RunStore> {
  store = isDatabaseAvailable() ? new PgRunStore() : new MemoryRunStore();
  await store.init();
  logger.info(`Run store ready (${store.mode})`);
  return store;
}

export function runStore(): RunStore {
  if (!store) {
    throw new Error('Run store has not been initialised - call initRunStore() first');
  }
  return store;
}
