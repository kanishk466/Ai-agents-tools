import { logger } from '../utils/logger';
import { chat } from './llm/llm.service';
import type { LlmMessage } from './llm/llm.types';
import { toolsPromptBlock } from './tools/registry';
import type { RegisteredTool } from './tools/tool.types';
import type { AgentStep, RunStats, Source, SseEvent } from '../types';

export interface ReactOptions {
  runId: string;
  sessionId: string;
  query: string;
  tools: RegisteredTool[];
  /** Prior conversation turns (already trimmed), fed for multi-turn memory. */
  history: LlmMessage[];
  budgetUsd: number;
  maxIterations: number;
  totalTimeoutMs: number;
  emit: (event: SseEvent) => void;
}

export interface ReactOutcome {
  answer: string;
  steps: AgentStep[];
  sources: Source[];
  stats: RunStats;
}

interface ParsedTurn {
  thought: string | null;
  action: string | null;
  args: unknown;
  answer: string | null;
}

function buildSystemPrompt(tools: RegisteredTool[]): string {
  return [
    'You are a autonomous research agent. You solve the user\'s task by reasoning in a strict loop and calling tools.',
    '',
    'On every turn reply with EXACTLY one of these two formats:',
    '',
    'Thought: <your reasoning about what to do next>',
    'Action: <tool_name>',
    'Action Input: <a single-line JSON object matching the tool input>',
    '',
    'or, once you have enough information:',
    '',
    'Thought: <why you are done>',
    'Answer: <the final, well-structured markdown answer for the user>',
    '',
    'Rules:',
    '- Never invent tool results. Base your answer only on Observations.',
    '- Cite sources by URL when web_search provides them.',
    '- Call at most one tool per turn.',
    '- If a tool fails, try a different approach instead of repeating it.',
    '- Stop as soon as you can write the Answer. Do not keep looping.',
    '',
    'Available tools:',
    toolsPromptBlock(tools),
  ].join('\n');
}

/** Extracts Thought/Action/Answer from a model reply. */
export function parseReAct(text: string): ParsedTurn {
  const thoughtMatch = text.match(/Thought:\s*([\s\S]*?)(?=\n\s*(?:Action|Answer):|$)/i);
  const thought = thoughtMatch ? thoughtMatch[1].trim() : null;

  const actionMatch = text.match(/^\s*Action:\s*([a-zA-Z0-9_]+)\s*$/im);
  if (actionMatch) {
    const inputMatch = text.match(/^\s*Action Input:\s*([\s\S]*?)\s*$/im);
    const raw = inputMatch ? inputMatch[1].trim() : '{}';
    let args: unknown = {};
    try {
      args = JSON.parse(raw);
    } catch {
      args = { _raw: raw };
    }
    return { thought, action: actionMatch[1], args, answer: null };
  }

  const answerMatch = text.match(/Answer:\s*([\s\S]*)/i);
  const answer = answerMatch ? answerMatch[1].trim() : text.trim();
  return { thought, action: null, args: null, answer };
}

/**
 * The ReAct loop: Thought → Action → Observation → repeat, bounded by
 * iteration count, cost budget and a total wall-clock timeout. Emits SSE
 * events for every thought/action/observation as it happens.
 */
export async function runReAct(options: ReactOptions): Promise<ReactOutcome> {
  const { runId, sessionId, query, tools, history, emit } = options;
  const maxIterations = options.maxIterations;
  const budgetUsd = options.budgetUsd;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('total run timeout exceeded')),
    options.totalTimeoutMs,
  );

  const started = Date.now();
  const steps: AgentStep[] = [];
  const toolsUsed = new Set<string>();
  const sources = new Map<string, Source>(); // unique sources, stable order
  let costUsd = 0;
  let llmCalls = 0;
  let provider: string | null = null;
  let finalAnswer = '';
  let iterations = 0;

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(tools) },
    ...history,
    { role: 'user', content: query },
  ];

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      iterations = iteration;

      if (costUsd >= budgetUsd) {
        logger.warn(`run ${runId}: cost budget $${budgetUsd.toFixed(3)} reached - stopping`);
        finalAnswer = `Stopped early: cost budget of $${budgetUsd.toFixed(3)} was reached.`;
        break;
      }
      if (controller.signal.aborted) {
        finalAnswer = 'Stopped early: total run timeout exceeded.';
        break;
      }

      /* 1. Think — first show what the model is about to see, then call it. */
      emit({
        type: 'transcript',
        iteration,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const response = await chat(messages, { signal: controller.signal });
      llmCalls++;
      costUsd += response.costUsd;
      provider = response.provider;

      emit({
        type: 'reply',
        iteration,
        provider: response.provider,
        model: response.model,
        raw: response.text,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      emit({
        type: 'metrics',
        iteration,
        maxIterations,
        costUsd: Number(costUsd.toFixed(6)),
        llmCalls,
        provider,
        elapsedMs: Date.now() - started,
      });

      const turn = parseReAct(response.text);
      if (turn.thought) {
        emit({ type: 'thought', iteration, content: turn.thought });
      }

      /* 2. Act or finish */
      if (!turn.action) {
        finalAnswer = turn.answer ?? response.text;
        break;
      }

      emit({ type: 'action', iteration, tool: turn.action, args: turn.args });

      const tool = tools.find((t) => t.name === turn.action);
      let observation: string;
      let ok: boolean;

      if (!tool) {
        observation = `Unknown tool "${turn.action}". Available: ${tools.map((t) => t.name).join(', ')}.`;
        ok = false;
      } else {
        const result = await tool.run(turn.args, { runId, signal: controller.signal, meta: { sessionId } });
        observation = result.output;
        ok = result.ok;
        toolsUsed.add(tool.name);

        const discovered = (result.data?.sources as Source[] | undefined) ?? [];
        for (const source of discovered) sources.set(source.url, source);
      }

      emit({ type: 'observation', iteration, tool: turn.action, content: observation, ok });
      steps.push({
        iteration,
        thought: turn.thought,
        tool: turn.action,
        args: turn.args,
        observation,
        ok,
      });

      /* Feed the observation back for the next Thought. */
      messages.push({ role: 'assistant', content: response.text });
      messages.push({ role: 'user', content: `Observation: ${observation}` });
    }

    if (!finalAnswer) {
      finalAnswer =
        'Reached the maximum number of iterations before finishing. ' +
        'Here is the last observation:\n\n' +
        (steps.at(-1)?.observation ?? 'No tool was run.');
    }
  } finally {
    clearTimeout(timer);
  }

  const stats: RunStats = {
    iterations,
    toolsUsed: [...toolsUsed],
    timeSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    costUsd: Number(costUsd.toFixed(6)),
    llmCalls,
    provider,
  };

  return { answer: finalAnswer, steps, sources: [...sources.values()], stats };
}
