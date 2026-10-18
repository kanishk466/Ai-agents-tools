import { z } from 'zod';
import { wrapTool, type ToolSpec, type RegisteredTool, type ToolResult } from './tool.wrapper';

const input = z.object({ expression: z.string().trim().min(1, 'expression is required') });

/**
 * Safe arithmetic evaluator (recursive descent, no `eval`). Supports
 * + - * / ^ % , parentheses, unary minus and decimals.
 */
function evaluate(expression: string): number {
  let pos = 0;

  const skip = () => {
    while (pos < expression.length && /\s/.test(expression[pos])) pos++;
  };

  const parseExpr = (): number => {
    let value = parseTerm();
    for (;;) {
      skip();
      const op = expression[pos];
      if (op === '+' || op === '-') {
        pos++;
        const rhs = parseTerm();
        value = op === '+' ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    for (;;) {
      skip();
      const op = expression[pos];
      if (op === '*' || op === '/' || op === '%') {
        pos++;
        const rhs = parseFactor();
        if (op === '*') value *= rhs;
        else if (op === '/') value /= rhs;
        else value %= rhs;
      } else break;
    }
    return value;
  };

  const parseFactor = (): number => {
    const base = parseUnary();
    skip();
    if (expression[pos] === '^') {
      pos++;
      const exponent = parseFactor(); // right-associative
      return base ** exponent;
    }
    return base;
  };

  const parseUnary = (): number => {
    skip();
    const op = expression[pos];
    if (op === '-') {
      pos++;
      return -parseUnary();
    }
    if (op === '+') {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    skip();
    if (expression[pos] === '(') {
      pos++;
      const value = parseExpr();
      skip();
      if (expression[pos] !== ')') throw new Error('missing closing parenthesis');
      pos++;
      return value;
    }
    const start = pos;
    while (pos < expression.length && /[\d.]/.test(expression[pos])) pos++;
    if (start === pos) throw new Error(`unexpected token at position ${pos}`);
    const value = Number(expression.slice(start, pos));
    if (Number.isNaN(value)) throw new Error(`invalid number "${expression.slice(start, pos)}"`);
    return value;
  };

  const result = parseExpr();
  skip();
  if (pos < expression.length) throw new Error(`unexpected token "${expression[pos]}"`);
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');
  return result;
}

const spec: ToolSpec<z.infer<typeof input>> = {
  name: 'calculator',
  description: 'Evaluate an arithmetic expression (+ - * / ^ %, parentheses). Returns the number.',
  schemaHint: '{"expression": "2 * (3 + 4) ^ 2"}',
  input,
  retries: 0, // deterministic - retrying cannot help

  async execute({ expression }): Promise<ToolResult> {
    try {
      const value = evaluate(expression);
      // Trim floating-point noise (e.g. 0.30000000000000004).
      const rounded = Number(value.toPrecision(12));
      return { ok: true, output: `${expression} = ${rounded}`, data: { result: rounded } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Cannot evaluate "${expression}": ${reason}`, error: reason };
    }
  },
};

export const calculatorTool: RegisteredTool = wrapTool(spec);
