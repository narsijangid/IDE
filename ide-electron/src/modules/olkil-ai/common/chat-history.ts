import type { UiChatMessage } from './index';

/** Keep Firebase tiny: only 3 chats, auto-expire after 48h. */
export const CHAT_HISTORY_MAX = 3;
export const CHAT_HISTORY_TTL_MS = 48 * 60 * 60 * 1000;
export const CHAT_HISTORY_MAX_MESSAGES = 40;
export const CHAT_HISTORY_MAX_CONTENT = 6000;
export const CHAT_HISTORY_SAVE_DEBOUNCE_MS = 900;

export interface ChatHistorySummary {
  id: string;
  title: string;
  updatedAt: number;
  expiresAt: number;
  messageCount: number;
}

export interface PersistedChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface PersistedChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  messages: PersistedChatMessage[];
}

const KEEP_ROLES = new Set(['user', 'assistant', 'system']);

export function slimMessages(messages: UiChatMessage[]): PersistedChatMessage[] {
  const out: PersistedChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!KEEP_ROLES.has(m.role) || m.pending) {
      continue;
    }
    const content = (m.content || '').trim();
    if (!content) {
      continue;
    }
    out.push({
      id: m.id,
      role: m.role as PersistedChatMessage['role'],
      content:
        content.length > CHAT_HISTORY_MAX_CONTENT
          ? content.slice(0, CHAT_HISTORY_MAX_CONTENT) + '…'
          : content,
    });
  }
  if (out.length > CHAT_HISTORY_MAX_MESSAGES) {
    return out.slice(out.length - CHAT_HISTORY_MAX_MESSAGES);
  }
  return out;
}

export function titleFromMessages(messages: UiChatMessage[] | PersistedChatMessage[]): string {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && m.content?.trim()) {
      const t = m.content.trim().replace(/\s+/g, ' ');
      return t.length > 72 ? t.slice(0, 72) + '…' : t;
    }
  }
  return 'Untitled chat';
}

export function sessionHasUserContent(messages: UiChatMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && Boolean(m.content?.trim()));
}

/** Drop expired, keep newest N. Mutates nothing — returns new array. */
export function pruneSessions(
  sessions: PersistedChatSession[],
  now = Date.now(),
  max = CHAT_HISTORY_MAX,
): PersistedChatSession[] {
  return sessions
    .filter((s) => s.expiresAt > now && s.updatedAt > now - CHAT_HISTORY_TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, max);
}

export function toSummary(s: PersistedChatSession): ChatHistorySummary {
  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    expiresAt: s.expiresAt,
    messageCount: s.messages.length,
  };
}

export function upsertSession(
  sessions: PersistedChatSession[],
  next: PersistedChatSession,
  now = Date.now(),
): PersistedChatSession[] {
  const without = sessions.filter((s) => s.id !== next.id);
  return pruneSessions([next, ...without], now);
}
