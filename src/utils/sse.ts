import type { SseEvent } from '../types';

/** Headers every SSE response must set to keep the connection alive. */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable proxy buffering so events flush immediately (nginx / Render).
  'X-Accel-Buffering': 'no',
};

/** Serialize one event into an SSE `data:` frame. */
export function formatSseFrame(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Heartbeat comment frame that keeps idle connections from timing out. */
export const SSE_PING = ': ping\n\n';
