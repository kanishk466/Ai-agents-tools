/**
 * Shared domain types used across the agent engine, tools and API layer.
 */

/** A cited web source attached to an answer. */
export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

/** One Thought → Action → Observation cycle inside the ReAct loop. */
export interface AgentStep {
  iteration: number;
  thought: string | null;
  tool: string | null;
  args: unknown;
  observation: string;
  ok: boolean;
}

/** Cost / performance summary for a completed run. */
export interface RunStats {
  iterations: number;
  toolsUsed: string[];
  timeSeconds: number;
  costUsd: number;
  llmCalls: number;
  provider: string | null;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RunRecord {
  runId: string;
  sessionId: string;
  query: string;
  status: RunStatus;
  answer: string | null;
  sources: Source[];
  steps: AgentStep[];
  stats: Partial<RunStats>;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ReportRecord {
  id: string;
  runId: string;
  title: string;
  content: string;
  format: 'md' | 'json';
  createdAt: string;
}

/** Live view of a run returned by GET /api/agent/status/:id. */
export interface RunStatusView {
  runId: string;
  status: RunStatus;
  progress: number;
  currentStep: string | null;
  stepsCompleted: number;
  sessionId: string;
  query: string;
  result: {
    answer: string;
    sources: Source[];
    reportUrl: string | null;
    stats: Partial<RunStats>;
  } | null;
  error: string | null;
}

/** Events pushed over SSE while an agent run executes. */
export type SseEvent =
  | { type: 'status'; status: RunStatus; progress: number; step?: string }
  | { type: 'plan'; intent: string; tools: string[]; estimatedSteps: number; mode: string }
  | { type: 'thought'; iteration: number; content: string }
  | { type: 'action'; iteration: number; tool: string; args: unknown }
  | { type: 'observation'; iteration: number; tool: string; content: string; ok: boolean }
  | {
      type: 'transcript';
      iteration: number;
      messages: Array<{ role: string; content: string }>;
    }
  | {
      type: 'reply';
      iteration: number;
      provider: string;
      model: string;
      raw: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: 'metrics';
      iteration: number;
      maxIterations: number;
      costUsd: number;
      llmCalls: number;
      provider: string | null;
      elapsedMs: number;
    }
  | { type: 'final'; content: string; sources: Source[] }
  | { type: 'done'; stats: Partial<RunStats> }
  | { type: 'error'; message: string };
