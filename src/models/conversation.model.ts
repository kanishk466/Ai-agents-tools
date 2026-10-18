import crypto from 'node:crypto';
import { isDatabaseAvailable, getPool } from '../config/database';
import { logger } from '../utils/logger';
import type { ConversationTurn } from '../types';

export type ConversationRole = ConversationTurn['role'];

export interface ConversationStore {
  init(): Promise<void>;
  append(input: {
    sessionId: string;
    role: ConversationRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationTurn>;
  /** Recent turns for a session, oldest-first (fed back into the LLM context). */
  getRecent(sessionId: string, limit: number): Promise<ConversationTurn[]>;
  close(): Promise<void>;
  readonly mode: 'postgres' | 'memory';
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ─────────────────────────── PostgreSQL ─────────────────────────── */

class PgConversationStore implements ConversationStore {
  readonly mode = 'postgres' as const;

  async init(): Promise<void> {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        metadata    JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
    `);
  }

  private static rowToTurn(row: Record<string, unknown>): ConversationTurn {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as ConversationRole,
      content: row.content as string,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: new Date(row.created_at as Date).toISOString(),
    };
  }

  async append(input: {
    sessionId: string;
    role: ConversationRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationTurn> {
    const id = uuid();
    const { rows } = await getPool().query(
      `INSERT INTO conversations (id, session_id, role, content, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.sessionId, input.role, input.content, JSON.stringify(input.metadata ?? {})],
    );
    return PgConversationStore.rowToTurn(rows[0]);
  }

  async getRecent(sessionId: string, limit: number): Promise<ConversationTurn[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM (
         SELECT * FROM conversations
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [sessionId, limit],
    );
    return rows.map(PgConversationStore.rowToTurn);
  }

  async close(): Promise<void> {
    /* pool lifetime is owned by config/database.ts */
  }
}

/* ─────────────────────────── In-memory ──────────────────────────── */

class MemoryConversationStore implements ConversationStore {
  readonly mode = 'memory' as const;
  private turns: ConversationTurn[] = [];

  async init(): Promise<void> {
    /* nothing to bootstrap */
  }

  async append(input: {
    sessionId: string;
    role: ConversationRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationTurn> {
    const turn: ConversationTurn = {
      id: uuid(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: now(),
    };
    this.turns.push(turn);
    // Bound memory so a long-lived process cannot grow without limit.
    if (this.turns.length > 5000) this.turns.splice(0, this.turns.length - 5000);
    return turn;
  }

  async getRecent(sessionId: string, limit: number): Promise<ConversationTurn[]> {
    return this.turns
      .filter((turn) => turn.sessionId === sessionId)
      .slice(-limit)
      .map((turn) => ({ ...turn }));
  }

  async close(): Promise<void> {
    this.turns = [];
  }
}

/* ─────────────────────────── Singleton ──────────────────────────── */

let store: ConversationStore | null = null;

export async function initConversationStore(): Promise<ConversationStore> {
  store = isDatabaseAvailable() ? new PgConversationStore() : new MemoryConversationStore();
  await store.init();
  logger.info(`Conversation store ready (${store.mode})`);
  return store;
}

export function conversationStore(): ConversationStore {
  if (!store) {
    throw new Error('Conversation store has not been initialised - call initConversationStore() first');
  }
  return store;
}
