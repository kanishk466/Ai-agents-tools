import vm from 'node:vm';
import { z } from 'zod';
import { env } from '../../config/env';
import { normalizeWhitespace, truncate } from '../../utils/text';
import { wrapTool, type ToolSpec, type RegisteredTool, type ToolResult } from './tool.wrapper';

const input = z.object({ code: z.string().trim().min(1, 'code is required') });

/** Patterns that could escape the sandbox or damage the host. */
const BLOCKED = [
  /\brequire\s*\(/,
  /\bimport\b/,
  /\bprocess\b/,
  /\bchild_process\b/,
  /\bfs\s*\./,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\b__proto__\b/,
  /\bglobalThis\b/,
  /\bnew\s+Function\b/,
];

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const spec: ToolSpec<z.infer<typeof input>> = {
  name: 'execute_code',
  description:
    'Run a short, self-contained JavaScript snippet in a sandbox. console.log output and the final expression value are returned. No require/import/process.',
  schemaHint: '{"code": "console.log(1 + 1); 6 * 7"}',
  input,
  retries: 0,
  timeoutMs: env.CODE_TIMEOUT_MS,

  async execute({ code }): Promise<ToolResult> {
    for (const pattern of BLOCKED) {
      if (pattern.test(code)) {
        return {
          ok: false,
          output: `Code blocked by safety policy (matched forbidden pattern: ${pattern}).`,
          error: 'blocked',
        };
      }
    }

    const logs: string[] = [];
    const sandbox = {
      console: {
        log: (...args: unknown[]) => logs.push(args.map(format).join(' ')),
        info: (...args: unknown[]) => logs.push(args.map(format).join(' ')),
        warn: (...args: unknown[]) => logs.push(args.map(format).join(' ')),
        error: (...args: unknown[]) => logs.push(args.map(format).join(' ')),
      },
      Math,
      JSON,
    };

    try {
      const context = vm.createContext(sandbox);
      const script = new vm.Script(code, { filename: 'agent-snippet.js' });
      // `timeout` aborts synchronous infinite loops.
      const value = script.runInContext(context, {
        timeout: env.CODE_TIMEOUT_MS,
        displayErrors: true,
      });

      const resultText = value === undefined ? '' : `Result: ${format(value)}`;
      const output = normalizeWhitespace([...logs, resultText].filter(Boolean).join('\n'));
      return {
        ok: true,
        output: output || '(no output)',
        data: { logs, result: value === undefined ? null : value },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const output = normalizeWhitespace(
        [...logs, `Error: ${reason}`].filter(Boolean).join('\n'),
      );
      return { ok: false, output: truncate(output, env.TOOL_RESULT_MAX_CHARS), error: reason };
    }
  },
};

export const executeCodeTool: RegisteredTool = wrapTool(spec);
