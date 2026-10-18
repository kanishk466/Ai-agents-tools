import type { LlmMessage } from './llm/llm.types';
import { conversationStore } from '../models/conversation.model';
import type { ConversationRole } from '../models/conversation.model';

/** Turns of history fed back into the LLM context. */
export const HISTORY_TURNS = 8;
const MAX_TURN_CHARS = 2000;

/** Loads recent session history as chat messages (oldest-first). */
export async function loadHistory(sessionId: string): Promise<LlmMessage[]> {
  try {
    const turns = await conversationStore().getRecent(sessionId, HISTORY_TURNS);
    return turns
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
      .map((turn) => ({
        role: turn.role as 'user' | 'assistant',
        content: turn.content.slice(0, MAX_TURN_CHARS),
      }));
  } catch {
    return []; // memory is best-effort
  }
}

/** Persists one turn of the conversation. */
export async function remember(
  sessionId: string,
  role: ConversationRole,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await conversationStore().append({ sessionId, role, content: content.slice(0, 8000), metadata });
  } catch {
    /* memory is best-effort */
  }
}
