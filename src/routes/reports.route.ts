import type { FastifyInstance } from 'fastify';
import { reportStore } from '../models/report.model';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/reports/:runId — the generated markdown report for a run. */
  app.get('/api/reports/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const report = await reportStore().getByRun(runId);
    if (!report) return reply.code(404).send({ error: 'No report for this run' });

    const accept = String(request.headers.accept ?? '');
    if (accept.includes('application/json')) {
      return reply.send({
        id: report.id,
        runId: report.runId,
        title: report.title,
        format: report.format,
        createdAt: report.createdAt,
        content: report.content,
      });
    }

    return reply.type('text/markdown; charset=utf-8').send(report.content);
  });
}
