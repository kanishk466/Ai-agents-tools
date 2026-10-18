import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { truncate } from '../../utils/text';
import type { RegisteredTool, ToolContext, ToolResult, ToolSpec } from './tool.types';

// Re-export the tool contract so consumers can import everything from one place.
export type { RegisteredTool, ToolContext, ToolResult, ToolSpec };

/**
 * Tool wrapper — the common layer every tool passes through. It applies, in
 * order: input validation → retry (infra failures only) → per-call timeout →
 * output truncation → logging.
 */
export function wrapTool<TInput>(spec: ToolSpec<TInput>): RegisteredTool {
  const attempts = (spec.retries ?? 2) + 1;
  const timeoutMs = spec.timeoutMs ?? env.TOOL_TIMEOUT_MS;

  async function runOnce(input: TInput, ctx: ToolContext): Promise<ToolResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('tool timeout')), timeoutMs);
    const onOuterAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onOuterAbort, { once: true });

    try {
      return await spec.execute(input, { ...ctx, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  return {
    name: spec.name,
    description: spec.description,
    schemaHint: spec.schemaHint,

    async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const started = Date.now();

      /* 1. Validate */
      const parsed = spec.input.safeParse(rawInput);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        logger.warn(`tool ${spec.name} invalid input: ${detail}`);
        return { ok: false, output: `Invalid input for ${spec.name}: ${detail}`, error: 'validation' };
      }

      /* 2-4. Execute with retry + timeout */
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (ctx.signal.aborted) {
          return { ok: false, output: `Tool ${spec.name} aborted (run budget exhausted).`, error: 'aborted' };
        }
        try {
          const result = await runOnce(parsed.data, ctx);
          const safe: ToolResult = {
            ...result,
            output: truncate(result.output, env.TOOL_RESULT_MAX_CHARS),
          };
          logger.debug(
            `tool ${spec.name} ok=${safe.ok} attempt=${attempt} ${Date.now() - started}ms`,
          );
          return safe;
        } catch (err) {
          lastError = err;
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn(`tool ${spec.name} attempt ${attempt}/${attempts} failed: ${reason}`);
          if (attempt < attempts) await sleep(250 * attempt);
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError);
      return {
        ok: false,
        output: `Tool ${spec.name} failed after ${attempts} attempt(s): ${message}`,
        error: message,
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
