import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { normalizeWhitespace, truncate } from '../../utils/text';
import { cacheGet, cacheSet } from '../cache.service';
import { wrapTool, type ToolSpec } from './tool.wrapper';
import type { RegisteredTool, ToolResult } from './tool.types';
import type { Source } from '../../types';

interface SearchPayload {
  answer: string | null;
  sources: Source[];
}

const input = z.object({ query: z.string().trim().min(2, 'query is too short') });

/** Tavily (keyed) primary search. */
async function searchTavily(query: string, signal: AbortSignal): Promise<SearchPayload> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      max_results: 5,
      include_answer: true,
    }),
    signal,
  });

  if (!response.ok) {
    const error = new Error(`Tavily ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const json = (await response.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  const sources: Source[] = (json.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? 'Untitled',
    url: r.url ?? '',
    snippet: r.content ? truncate(normalizeWhitespace(r.content), 240) : undefined,
  }));

  return { answer: json.answer ?? null, sources };
}

/** DuckDuckGo (keyless) fallback search. */
async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchPayload> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ai-agent/1.0' },
    signal,
  });
  if (!response.ok) throw new Error(`DuckDuckGo ${response.status}`);

  const json = (await response.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  const sources: Source[] = [];
  if (json.AbstractURL && json.AbstractText) {
    sources.push({
      title: json.Heading || json.AbstractURL,
      url: json.AbstractURL,
      snippet: truncate(normalizeWhitespace(json.AbstractText), 240),
    });
  }
  for (const topic of json.RelatedTopics ?? []) {
    const nested = topic.Topics ?? [];
    for (const item of nested.length ? nested : [topic]) {
      if (item.FirstURL && item.Text) {
        sources.push({
          title: truncate(item.Text.split(' - ')[0] || item.FirstURL, 120),
          url: item.FirstURL,
          snippet: truncate(normalizeWhitespace(item.Text), 240),
        });
      }
      if (sources.length >= 6) break;
    }
    if (sources.length >= 6) break;
  }

  return { answer: json.AbstractText || null, sources: sources.slice(0, 6) };
}

const spec: ToolSpec<z.infer<typeof input>> = {
  name: 'web_search',
  description:
    'Search the web for current information. Returns a short answer plus titled sources with URLs.',
  schemaHint: '{"query": "search terms"}',
  input,
  retries: 2, // network flakiness is retryable

  async execute({ query }, ctx): Promise<ToolResult> {
    const cacheKey = `search:${query.toLowerCase()}`;
    const cached = await cacheGet<SearchPayload>(cacheKey);
    if (cached) {
      return {
        ok: true,
        output: formatOutput(cached, true),
        data: { sources: cached.sources, cached: true },
      };
    }

    // Primary: Tavily. Fallback: DuckDuckGo (keyless).
    let payload: SearchPayload;
    let engine: string;
    if (env.useTavily) {
      try {
        payload = await searchTavily(query, ctx.signal);
        engine = 'tavily';
      } catch (err) {
        logger.warn(`Tavily failed (${(err as Error).message}) - falling back to DuckDuckGo`);
        payload = await searchDuckDuckGo(query, ctx.signal);
        engine = 'duckduckgo';
      }
    } else {
      payload = await searchDuckDuckGo(query, ctx.signal);
      engine = 'duckduckgo';
    }

    if (payload.sources.length === 0 && !payload.answer) {
      return { ok: false, output: `No results found for "${query}".`, error: 'no-results' };
    }

    await cacheSet(cacheKey, payload, env.SEARCH_CACHE_TTL);

    return {
      ok: true,
      output: formatOutput(payload, false),
      data: { sources: payload.sources, engine },
    };
  },
};

function formatOutput(payload: SearchPayload, cached: boolean): string {
  const lines: string[] = [];
  if (payload.answer) lines.push(payload.answer);
  if (payload.sources.length) {
    lines.push('', 'Sources:');
    for (const source of payload.sources) {
      lines.push(`- ${source.title}: ${source.url}`);
      if (source.snippet) lines.push(`  ${source.snippet}`);
    }
  }
  if (cached) lines.push('', '(cached result)');
  return normalizeWhitespace(lines.join('\n'));
}

export const webSearchTool: RegisteredTool = wrapTool(spec);
