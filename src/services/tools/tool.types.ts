import type { ZodType } from 'zod';

/** Context handed to every tool execution. */
export interface ToolContext {
  runId: string;
  /** Aborted when the run's total budget is exhausted. */
  signal: AbortSignal;
  /** Shared bag (e.g. sessionId) that tools like save_report may need. */
  meta: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** LLM-facing string (truncated by the wrapper). */
  output: string;
  /** Structured extras (e.g. sources) surfaced to the finalizer. */
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * A tool specification.
 *
 * Contract: `execute` should THROW for infrastructure failures (network down,
 * timeout) so the wrapper retries, and RETURN `{ ok: false }` for logical
 * failures (blocked site, bad expression) which must not be retried.
 */
export interface ToolSpec<TInput> {
  name: string;
  description: string;
  /** Short schema hint injected into the ReAct system prompt. */
  schemaHint: string;
  input: ZodType<TInput>;
  /** Extra attempts after the first failure (default 2). */
  retries?: number;
  /** Per-call timeout override (default env.TOOL_TIMEOUT_MS). */
  timeoutMs?: number;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/** A validated, wrapped tool ready for the registry. */
export interface RegisteredTool {
  name: string;
  description: string;
  schemaHint: string;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
