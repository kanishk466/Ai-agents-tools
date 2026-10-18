import { env } from '../config/env';
import { logger } from '../utils/logger';
import { runStore } from '../models/run.model';
import { plan, type Plan } from './planner.service';
import { runReAct, parseReAct } from './react.service';
import { chat } from './llm/llm.service';
import { loadHistory, remember } from './memory.service';
import { finalize } from './finalizer.service';
import { sanitize, recordSpend } from './guardrails.service';
import { resolveTools } from './tools/registry';
import type {
  AgentStep,
  RunStats,
  RunStatus,
  RunStatusView,
  Source,
  SseEvent,
} from '../types';

export interface RunConfig {
  maxIterations: number;
  budgetUsd: number;
  tools?: string[];
  autoReport: boolean;
}

export function defaultConfig(): RunConfig {
  return {
    maxIterations: env.MAX_ITERATIONS,
    budgetUsd: env.MAX_COST_USD,
    autoReport: true,
  };
}

interface LiveRun {
  runId: string;
  sessionId: string;
  identity: string;
  query: string;
  status: RunStatus;
  progress: number;
  currentStep: string | null;
  stepsCompleted: number;
  maxIterations: number;
  answer: string | null;
  sources: Source[];
  stats: Partial<RunStats>;
  reportUrl: string | null;
  error: string | null;
  events: SseEvent[];
  subscribers: Set<(event: SseEvent) => void>;
}

const liveRuns = new Map<string, LiveRun>();
const EVENT_BUFFER_CAP = 500;

function emit(live: LiveRun, event: SseEvent): void {
  switch (event.type) {
    case 'status':
      live.status = event.status;
      live.progress = event.progress;
      if (event.step) live.currentStep = event.step;
      break;
    case 'thought':
      live.currentStep = event.content;
      break;
    case 'action':
      live.currentStep = `Running ${event.tool}…`;
      break;
    case 'observation':
      live.stepsCompleted = event.iteration;
      live.progress = Math.min(92, Math.round((event.iteration / Math.max(1, live.maxIterations)) * 84) + 8);
      break;
    case 'done':
      live.status = 'completed';
      live.progress = 100;
      live.currentStep = null;
      break;
    case 'error':
      live.status = 'failed';
      break;
  }

  live.events.push(event);
  if (live.events.length > EVENT_BUFFER_CAP) live.events.shift();

  for (const listener of live.subscribers) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must not break the run */
    }
  }
}

export interface StartRunInput {
  query: string;
  sessionId: string;
  identity: string;
  config: RunConfig;
}

/** Creates a run, persists its initial row, and kicks off async execution. */
export async function startRun(input: StartRunInput): Promise<{ runId: string; plan: Plan }> {
  const record = await runStore().createRun({ sessionId: input.sessionId, query: input.query });
  const runPlan = plan(input.query);

  const live: LiveRun = {
    runId: record.runId,
    sessionId: input.sessionId,
    identity: input.identity,
    query: input.query,
    status: 'queued',
    progress: 0,
    currentStep: null,
    stepsCompleted: 0,
    maxIterations: input.config.maxIterations,
    answer: null,
    sources: [],
    stats: {},
    reportUrl: null,
    error: null,
    events: [],
    subscribers: new Set(),
  };
  liveRuns.set(record.runId, live);

  // Fire and forget - the API returns 202 immediately.
  void executeRun(live, input.config, runPlan);

  return { runId: record.runId, plan: runPlan };
}

async function executeRun(live: LiveRun, config: RunConfig, runPlan: Plan): Promise<void> {
  const started = Date.now();

  try {
    emit(live, { type: 'status', status: 'running', progress: 5, step: `Planning (${runPlan.intent})…` });
    emit(live, {
      type: 'plan',
      intent: runPlan.intent,
      tools: runPlan.suggestedTools,
      estimatedSteps: runPlan.estimatedSteps,
      mode: env.llmMode,
    });

    const history = await loadHistory(live.sessionId);
    const tools = resolveTools(config.tools);

    let answer: string;
    let steps: AgentStep[] = [];
    let sources: Source[] = [];
    let stats: RunStats;

    if (!runPlan.needsTools) {
      /* Simple query - a single direct LLM call, no loop. */
      emit(live, { type: 'status', status: 'running', progress: 20, step: 'Answering directly…' });

      const messages = [
        {
          role: 'system' as const,
          content:
            'You are a helpful assistant. Answer the user directly in clear, concise markdown. Be accurate.',
        },
        ...history,
        { role: 'user' as const, content: live.query },
      ];
      emit(live, { type: 'transcript', iteration: 1, messages: messages.map((m) => ({ role: m.role, content: m.content })) });

      const response = await chat(messages);
      // Cloud models answer plainly, but the offline actor (and some models)
      // still reply in the ReAct protocol - strip it so users see the answer.
      answer = /^\s*(Thought:|Answer:)/im.test(response.text)
        ? (parseReAct(response.text).answer ?? response.text)
        : response.text;
      stats = {
        iterations: 1,
        toolsUsed: [],
        timeSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
        costUsd: Number(response.costUsd.toFixed(6)),
        llmCalls: 1,
        provider: response.provider,
      };
      emit(live, {
        type: 'reply',
        iteration: 1,
        provider: response.provider,
        model: response.model,
        raw: response.text,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      emit(live, {
        type: 'metrics',
        iteration: 1,
        maxIterations: config.maxIterations,
        costUsd: stats.costUsd,
        llmCalls: 1,
        provider: response.provider,
        elapsedMs: Date.now() - started,
      });
      emit(live, { type: 'thought', iteration: 1, content: 'Answered directly (no tools needed).' });
    } else {
      /* Complex query - run the ReAct loop. */
      const outcome = await runReAct({
        runId: live.runId,
        sessionId: live.sessionId,
        query: live.query,
        tools,
        history,
        budgetUsd: config.budgetUsd,
        maxIterations: config.maxIterations,
        totalTimeoutMs: env.TOTAL_TIMEOUT_MS,
        emit: (event) => emit(live, event),
      });
      answer = outcome.answer;
      steps = outcome.steps;
      sources = outcome.sources;
      stats = outcome.stats;
    }

    emit(live, { type: 'status', status: 'running', progress: 95, step: 'Finalizing…' });

    const finalized = await finalize({
      runId: live.runId,
      query: live.query,
      answer,
      steps,
      sources,
      autoReport: config.autoReport,
    });
    const cleanAnswer = sanitize(finalized.answer);

    await runStore().updateRun(live.runId, {
      status: 'completed',
      answer: cleanAnswer,
      sources: finalized.sources,
      steps,
      stats,
      completedAt: new Date().toISOString(),
    });

    await remember(live.sessionId, 'user', live.query);
    await remember(live.sessionId, 'assistant', cleanAnswer, { runId: live.runId });
    await recordSpend(live.identity, stats.costUsd);

    live.answer = cleanAnswer;
    live.sources = finalized.sources;
    live.stats = stats;
    live.reportUrl = finalized.reportUrl;

    emit(live, { type: 'final', content: cleanAnswer, sources: finalized.sources });
    emit(live, { type: 'done', stats });

    logger.info(
      `run ${live.runId} completed in ${stats.timeSeconds}s ` +
        `(${stats.iterations} iters, ${stats.toolsUsed.length} tools, $${stats.costUsd}, ${stats.provider})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`run ${live.runId} failed: ${message}`);
    live.error = message;
    await runStore()
      .updateRun(live.runId, { status: 'failed', error: message, completedAt: new Date().toISOString() })
      .catch(() => undefined);
    emit(live, { type: 'error', message });
  }
}

/** Builds the status payload for GET /api/agent/status/:runId. */
export async function getRunView(runId: string): Promise<RunStatusView | null> {
  const live = liveRuns.get(runId);
  if (live) {
    return {
      runId: live.runId,
      status: live.status,
      progress: live.progress,
      currentStep: live.currentStep,
      stepsCompleted: live.stepsCompleted,
      sessionId: live.sessionId,
      query: live.query,
      result:
        live.status === 'completed' && live.answer
          ? {
              answer: live.answer,
              sources: live.sources,
              reportUrl: live.reportUrl,
              stats: live.stats,
            }
          : null,
      error: live.error,
    };
  }

  // Fall back to the durable store (run finished before this process started,
  // or the live entry was evicted).
  const record = await runStore().getRun(runId);
  if (!record) return null;
  return {
    runId: record.runId,
    status: record.status,
    progress: record.status === 'completed' ? 100 : record.status === 'failed' ? 100 : 0,
    currentStep: null,
    stepsCompleted: record.steps.length,
    sessionId: record.sessionId,
    query: record.query,
    result:
      record.status === 'completed' && record.answer
        ? {
            answer: record.answer,
            sources: record.sources,
            reportUrl: `/api/reports/${record.runId}`,
            stats: record.stats,
          }
        : null,
    error: record.error,
  };
}

/**
 * Subscribes to a run's live events. Replays the buffered backlog first so a
 * late subscriber still sees the whole trace, then streams new events.
 */
export function subscribe(
  runId: string,
  listener: (event: SseEvent) => void,
): (() => void) | null {
  const live = liveRuns.get(runId);
  if (!live) return null;

  for (const event of live.events) listener(event);
  if (live.status === 'completed' || live.status === 'failed') return () => undefined;

  live.subscribers.add(listener);
  return () => live.subscribers.delete(listener);
}

export async function history(sessionId: string, limit: number): Promise<RunStatusView[]> {
  const records = await runStore().listRunsBySession(sessionId, limit);
  return records.map((record) => ({
    runId: record.runId,
    status: record.status,
    progress: record.status === 'completed' ? 100 : 0,
    currentStep: null,
    stepsCompleted: record.steps.length,
    sessionId: record.sessionId,
    query: record.query,
    result:
      record.status === 'completed' && record.answer
        ? { answer: record.answer, sources: record.sources, reportUrl: `/api/reports/${record.runId}`, stats: record.stats }
        : null,
    error: record.error,
  }));
}
