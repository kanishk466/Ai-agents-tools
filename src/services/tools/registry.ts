import type { RegisteredTool } from './tool.types';
import { webSearchTool } from './web-search.tool';
import { scrapeUrlTool } from './scrape-url.tool';
import { calculatorTool } from './calculator.tool';
import { executeCodeTool } from './execute-code.tool';
import { saveReportTool } from './save-report.tool';

/** Every tool the agent can use, in a stable order. */
const ALL_TOOLS: RegisteredTool[] = [
  webSearchTool,
  scrapeUrlTool,
  calculatorTool,
  executeCodeTool,
  saveReportTool,
];

export const TOOL_NAMES: string[] = ALL_TOOLS.map((tool) => tool.name);

const byName = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

/** Restricts the toolset to a request-supplied whitelist (all when omitted). */
export function resolveTools(whitelist?: string[]): RegisteredTool[] {
  if (!whitelist || whitelist.length === 0) return ALL_TOOLS;
  const picked = whitelist.map((name) => byName.get(name)).filter((t): t is RegisteredTool => Boolean(t));
  return picked.length ? picked : ALL_TOOLS;
}

export function getTool(name: string): RegisteredTool | undefined {
  return byName.get(name);
}

/** Name + description of every tool, for the health endpoint. */
export function toolHealth(): { name: string; description: string }[] {
  return ALL_TOOLS.map((tool) => ({ name: tool.name, description: tool.description }));
}

/** Renders the tool list for the ReAct system prompt. */
export function toolsPromptBlock(tools: RegisteredTool[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}\n    Input: ${tool.schemaHint}`).join('\n');
}
