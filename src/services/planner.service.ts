/**
 * Planner — decides whether a query can be answered directly (a single LLM
 * call, no tools) or needs the full ReAct loop, and which tools to allow.
 *
 * Classification is a cheap deterministic heuristic so we never spend an extra
 * LLM call just to pick a plan.
 */

export type Intent = 'simple_qa' | 'research' | 'comparison' | 'computation' | 'scrape' | 'report';

export interface Plan {
  intent: Intent;
  needsTools: boolean;
  suggestedTools: string[];
  estimatedSteps: number;
}

const SEARCH_INTENT =
  /\b(search|look ?up|latest|current|today|news|price|cost|rate|stock|weather|forecast|who|what|when|where|why|how many|meaning|definition|score|release|update)\b/i;
const COMPARE = /\b(vs\.?|versus)\b|,/i;
const REPORT = /\b(save|write|generate|create|export)\b.*\b(report|summary|document)\b/i;
const URL = /https?:\/\/\S+/i;
const CODE = /\b(run|execute|eval|evaluate|compute)\b.*\b(code|snippet|script|javascript|js)\b/i;

/** A plausible arithmetic expression (digits + operators). */
function looksLikeMath(query: string): boolean {
  const cleaned = query
    .replace(/^(what\s+is|calculate|compute|solve|evaluate)\s+/i, '')
    .replace(/[?=]+$/g, '')
    .trim();
  return /^[\d\s+\-*/().^%]+$/.test(cleaned) && /[+\-*/^%]/.test(cleaned);
}

export function plan(query: string): Plan {
  const q = query.trim();

  if (URL.test(q)) {
    return { intent: 'scrape', needsTools: true, suggestedTools: ['scrape_url'], estimatedSteps: 2 };
  }

  if (REPORT.test(q)) {
    return { intent: 'report', needsTools: true, suggestedTools: ['web_search', 'save_report'], estimatedSteps: 3 };
  }

  if (CODE.test(q)) {
    return { intent: 'computation', needsTools: true, suggestedTools: ['execute_code'], estimatedSteps: 2 };
  }

  if (COMPARE.test(q)) {
    return { intent: 'comparison', needsTools: true, suggestedTools: ['web_search'], estimatedSteps: 4 };
  }

  if (looksLikeMath(q)) {
    return { intent: 'computation', needsTools: true, suggestedTools: ['calculator'], estimatedSteps: 2 };
  }

  if (SEARCH_INTENT.test(q)) {
    return { intent: 'research', needsTools: true, suggestedTools: ['web_search'], estimatedSteps: 3 };
  }

  return { intent: 'simple_qa', needsTools: false, suggestedTools: [], estimatedSteps: 1 };
}
