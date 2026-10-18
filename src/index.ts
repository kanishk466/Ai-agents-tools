import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';

import { env } from './config/env';
import { logger } from './utils/logger';
import { initDatabase, closeDatabase } from './config/database';
import { initKv, closeKv, kvStore } from './config/kv';
import { initRunStore, runStore } from './models/run.model';
import { initConversationStore } from './models/conversation.model';
import { initReportStore } from './models/report.model';
import { toolHealth } from './services/tools/registry';
import { activeProviders, llmHealth } from './services/llm/llm.service';
import { agentRoutes } from './routes/agent.route';
import { reportRoutes } from './routes/reports.route';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function main(): Promise<void> {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024, // JSON bodies only
    trustProxy: true,
  });

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as { statusCode?: number; code?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    request.log.error(rawError, 'request error');
    return reply.code(statusCode).send({ error: error.message ?? 'Internal server error' });
  });

  await app.register(fastifyCors, { origin: true });

  /* ── Infrastructure ─────────────────────────────────────────── */

  await initDatabase();
  await initKv();
  await initRunStore();
  await initConversationStore();
  await initReportStore();
  const tools = toolHealth();

  /* ── Routes ─────────────────────────────────────────────────── */

  await app.register(agentRoutes);
  await app.register(reportRoutes);

  app.get('/api/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      mode: env.AGENT_MODE,
      llm: { ...llmHealth(), providers: activeProviders() },
      search: { engine: env.searchMode, cacheTtlSeconds: env.SEARCH_CACHE_TTL },
      storage: {
        kv: kvStore().mode,
        runs: runStore().mode,
      },
      guardrails: {
        maxIterations: env.MAX_ITERATIONS,
        maxCostUsd: env.MAX_COST_USD,
        totalTimeoutMs: env.TOTAL_TIMEOUT_MS,
        dailyLimitPerIp: env.DAILY_LIMIT_PER_IP,
      },
      tools,
    });
  });

  if (fs.existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  }

  /* ── Boot ───────────────────────────────────────────────────── */

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  logger.info('AI agent ready');
  logger.info(`  UI          http://localhost:${env.PORT}/`);
  logger.info(`  Health      http://localhost:${env.PORT}/api/health`);
  logger.info(`  Mode        AGENT_MODE=${env.AGENT_MODE} (llm=${env.llmMode}, search=${env.searchMode})`);
  logger.info(`  LLM chain   ${activeProviders().join(' → ')}`);

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received - shutting down`);
    await app.close().catch(() => undefined);
    await closeKv();
    await closeDatabase();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
