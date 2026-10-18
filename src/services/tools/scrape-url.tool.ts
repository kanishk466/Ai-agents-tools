import { z } from 'zod';
import { load } from 'cheerio';
import { normalizeWhitespace, truncate } from '../../utils/text';
import { wrapTool, type ToolSpec, type RegisteredTool, type ToolResult } from './tool.wrapper';

const input = z.object({ url: z.string().url('a valid URL is required') });

/** Hostnames that must never be fetched (SSRF guard). */
const BLOCKED_HOSTS = new Set(['localhost', '0.0.0.0', '::1', '[::1]']);

function isPrivateHost(hostname: string): boolean {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) return true;
  // 172.16.0.0 – 172.31.255.255
  const match = hostname.match(/^172\.(\d+)\./);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

const spec: ToolSpec<z.infer<typeof input>> = {
  name: 'scrape_url',
  description:
    'Fetch a public web page and return its title and readable text content. Fails on private/internal hosts.',
  schemaHint: '{"url": "https://example.com/page"}',
  input,
  retries: 1,

  async execute({ url }, ctx): Promise<ToolResult> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, output: 'Only http(s) URLs can be scraped.', error: 'bad-protocol' };
    }
    if (isPrivateHost(parsed.hostname)) {
      return { ok: false, output: 'Scraping internal/private hosts is blocked.', error: 'ssrf' };
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ai-agent/1.0 (+https://example.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: ctx.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      // 403/404 are logical outcomes - returned, not thrown, so no retry.
      return {
        ok: false,
        output: `Scraping failed: ${response.status} ${response.statusText} (site blocked or page missing).`,
        error: String(response.status),
      };
    }

    const html = await response.text();
    const $ = load(html);

    const title = normalizeWhitespace($('title').first().text() || parsed.hostname);
    $('script, style, noscript, svg, iframe').remove();
    const bodyText = normalizeWhitespace($('body').text() || '');
    const content = truncate(bodyText, 4000);

    if (!content) {
      return {
        ok: true,
        output: `Page title: ${title}\n(no readable text - the page may be JavaScript-rendered)`,
        data: { title },
      };
    }

    return {
      ok: true,
      output: `Title: ${title}\n\nContent:\n${content}`,
      data: { title, url },
    };
  },
};

export const scrapeUrlTool: RegisteredTool = wrapTool(spec);
