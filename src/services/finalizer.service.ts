import { reportStore } from '../models/report.model';
import { sanitize } from './guardrails.service';
import type { AgentStep, Source } from '../types';

export interface FinalizeInput {
  runId: string;
  query: string;
  answer: string;
  steps: AgentStep[];
  sources: Source[];
  /** Force a markdown report to be written regardless of size. */
  autoReport: boolean;
}

export interface FinalizedAnswer {
  answer: string;
  sources: Source[];
  reportUrl: string | null;
}

/**
 * Finalizer — cleans the raw agent output: sanitises it, appends a citation
 * block, and (when useful) persists a full markdown report of the run.
 */
export async function finalize(input: FinalizeInput): Promise<FinalizedAnswer> {
  let answer = sanitize(input.answer).trim();

  const missingSources = input.sources.filter((source) => source.url && !answer.includes(source.url));
  if (missingSources.length > 0) {
    const citations = missingSources.map((source) => `- [${source.title}](${source.url})`).join('\n');
    answer = `${answer}\n\n---\n**Sources**\n${citations}`;
  }

  let reportUrl: string | null = null;
  // Save a trace report whenever the agent actually did something (used a tool
  // or gathered sources). Pure no-tool answers stay lightweight.
  const shouldReport = input.autoReport && (input.sources.length > 0 || input.steps.length > 0);
  if (shouldReport) {
    const content = buildReportMarkdown(input, answer);
    try {
      await reportStore().save({
        runId: input.runId,
        title: `Report: ${input.query.slice(0, 60)}`,
        content,
        format: 'md',
      });
      reportUrl = `/api/reports/${input.runId}`;
    } catch {
      reportUrl = null; // report persistence is best-effort
    }
  }

  return { answer, sources: input.sources, reportUrl };
}

function buildReportMarkdown(input: FinalizeInput, answer: string): string {
  const lines: string[] = [];
  lines.push(`# Agent Report`, '');
  lines.push(`**Query:** ${input.query}`, '');
  lines.push(`**Run:** \`${input.runId}\` · ${new Date().toISOString()}`, '');
  lines.push(`## Answer`, '', answer, '');

  if (input.steps.length) {
    lines.push(`## Trace`, '');
    for (const step of input.steps) {
      lines.push(`### Step ${step.iteration}${step.tool ? ` → \`${step.tool}\`` : ''}`);
      if (step.thought) lines.push(`- **Thought:** ${step.thought}`);
      if (step.tool) lines.push(`- **Action:** ${step.tool} ${JSON.stringify(step.args)}`);
      lines.push(`- **Observation:** ${step.ok ? '' : '*(failed)* '}${truncateForReport(step.observation)}`, '');
    }
  }

  if (input.sources.length) {
    lines.push(`## Sources`, '');
    for (const source of input.sources) {
      lines.push(`- [${source.title}](${source.url})`);
    }
  }

  return lines.join('\n');
}

function truncateForReport(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
