import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { checkDailyLimit, checkSpendLimit } from '../services/guardrails.service';
import { defaultConfig, startRun, getRunView, subscribe, history } from '../services/runs.service';
import { SSE_HEADERS, SSE_PING, formatSseFrame } from '../utils/sse';
import type { SseEvent } from '../types';

const configSchema = z.object({
  maxIterations: z.number().int().positive().max(env.MAX_ITERATIONS).optional(),
  budget: z.number().positive().max(env.MAX_COST_USD).optional(),
  tools: z.array(z.string().trim().min(1)).min(1).optional(),
});

const runSchema = z.object({
  query: z
    .string()
    .trim()
    .min(3, 'query must be at least 3 characters')
    .max(env.QUERY_MAX_CHARS, `query must be at most ${env.QUERY_MAX_CHARS} characters`),
  sessionId: z.string().trim().min(1).max(120).optional(),
  config: configSchema.optional(),
});

const historyQuery = z.object({
  sessionId: z.string().trim().min(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/agent/run
   * Rate-limit + cost pre-check → create run → execute async → 202.
   */
  app.post('/api/agent/run', async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues,
      });
    }

    const identity = request.ip || 'unknown';

    /* Guardrail: daily request cap */
    const limit = await checkDailyLimit(identity);
    if (!limit.allowed) {
      return reply.code(429).send({
        error: `Daily limit reached (${limit.limit}/day). Try again in ${Math.ceil(limit.resetInSeconds / 3600)}h.`,
        used: limit.used,
        limit: limit.limit,
      });
    }

    /* Guardrail: daily spend cap */
    const spend = await checkSpendLimit(identity);
    if (!spend.allowed) {
      return reply.code(402).send({
        error: `Daily cost cap reached ($${spend.cap}). Try again tomorrow.`,
        spent: spend.spent,
        cap: spend.cap,
      });
    }

    const { query, sessionId, config } = parsed.data;
    const resolvedSession = sessionId ?? `session_${crypto.randomUUID().slice(0, 8)}`;

    const merged = defaultConfig();
    if (config?.maxIterations) merged.maxIterations = config.maxIterations;
    if (config?.budget) merged.budgetUsd = config.budget;
    if (config?.tools) merged.tools = config.tools;

    const { runId, plan } = await startRun({
      query,
      sessionId: resolvedSession,
      identity,
      config: merged,
    });

    return reply.code(202).send({
      runId,
      sessionId: resolvedSession,
      status: 'queued',
      plan,
      statusUrl: `/api/agent/status/${runId}`,
      streamUrl: `/api/agent/stream/${runId}`,
    });
  });

  /** GET /api/agent/status/:runId */
  app.get('/api/agent/status/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const view = await getRunView(runId);
    if (!view) return reply.code(404).send({ error: 'Run not found' });
    return reply.send(view);
  });

  /** GET /api/agent/stream/:runId — SSE live thoughts/actions/observations. */
  app.get('/api/agent/stream/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const view = await getRunView(runId);
    if (!view) return reply.code(404).send({ error: 'Run not found' });

    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);

    const write = (event: SseEvent) => {
      reply.raw.write(formatSseFrame(event));
    };

    const unsubscribe = subscribe(runId, write);
    const heartbeat = setInterval(() => reply.raw.write(SSE_PING), 15_000);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    request.raw.on('close', close);

    // Already finished → subscribe() replayed the backlog; close the stream.
    if (view.status === 'completed' || view.status === 'failed') close();
  });

  /** GET /api/agent/history?sessionId=...&limit=10 */
  app.get('/api/agent/history', async (request, reply) => {
    const parsed = historyQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'sessionId (and optional limit) required' });
    }
    const { sessionId, limit } = parsed.data;
    const sessions = await history(sessionId, limit);
    return reply.send({ sessions });
  });
}
