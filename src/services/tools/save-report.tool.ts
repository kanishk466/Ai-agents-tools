import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { reportStore } from '../../models/report.model';
import { slugify } from '../../utils/text';
import { wrapTool, type ToolSpec, type RegisteredTool, type ToolResult, type ToolContext } from './tool.wrapper';

const input = z.object({
  title: z.string().trim().min(1, 'title is required'),
  content: z.string().trim().min(1, 'content is required'),
});

const REPORTS_DIR = path.join(process.cwd(), 'reports');

const spec: ToolSpec<z.infer<typeof input>> = {
  name: 'save_report',
  description:
    'Persist a titled markdown report. Saves to the reports store and disk, and returns a URL to fetch it.',
  schemaHint: '{"title": "Report title", "content": "# Markdown body..."}',
  input,
  retries: 1,

  async execute({ title, content }, ctx: ToolContext): Promise<ToolResult> {
    const runId = typeof ctx.meta.runId === 'string' ? ctx.meta.runId : 'unknown';
    const markdown = `# ${title}\n\n> Run: \`${runId}\` · ${new Date().toISOString()}\n\n${content}\n`;

    const record = await reportStore().save({ runId, title, content: markdown, format: 'md' });

    // Best-effort disk copy (ephemeral on Render, but handy locally).
    let filePath: string | null = null;
    try {
      await fs.mkdir(REPORTS_DIR, { recursive: true });
      filePath = path.join(REPORTS_DIR, `${slugify(title)}-${record.id.slice(0, 8)}.md`);
      await fs.writeFile(filePath, markdown, 'utf8');
    } catch {
      filePath = null;
    }

    return {
      ok: true,
      output: [
        `Report saved: "${title}"`,
        `URL: /api/reports/${runId}`,
        filePath ? `File: ${filePath}` : 'File: (disk write skipped)',
      ].join('\n'),
      data: { reportId: record.id, url: `/api/reports/${runId}`, filePath },
    };
  },
};

export const saveReportTool: RegisteredTool = wrapTool(spec);
