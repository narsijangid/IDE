import type { OlkilSession } from './auth';
import { refreshSession } from './auth';

/** Same caps as the OLKIL desktop IDE: 3 chats, 48h TTL. */
export const CHAT_HISTORY_MAX = 3;
export const CHAT_HISTORY_TTL_MS = 48 * 60 * 60 * 1000;
export const CHAT_HISTORY_MAX_MESSAGES = 40;
export const CHAT_HISTORY_MAX_CONTENT = 6000;
export const CHAT_HISTORY_SAVE_DEBOUNCE_MS = 900;

const OLKIL_FIRESTORE_PROJECT = 'olkil-2c8ac';
const DOC_PATH = (uid: string) =>
  `projects/${OLKIL_FIRESTORE_PROJECT}/databases/(default)/documents/users/${encodeURIComponent(uid)}/data/chatHistory`;

export type ChatHistorySummary = {
  id: string;
  title: string;
  updatedAt: number;
  expiresAt: number;
  messageCount: number;
};

export type PersistedChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type PersistedChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  messages: PersistedChatMessage[];
};

export function slimMessages(messages: PersistedChatMessage[]): PersistedChatMessage[] {
  const out: PersistedChatMessage[] = [];
  for (const m of messages) {
    const content = (m.content || '').trim();
    if (!content || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system')) continue;
    out.push({
      id: m.id,
      role: m.role,
      content: content.length > CHAT_HISTORY_MAX_CONTENT ? content.slice(0, CHAT_HISTORY_MAX_CONTENT) + '…' : content,
    });
  }
  return out.length > CHAT_HISTORY_MAX_MESSAGES ? out.slice(out.length - CHAT_HISTORY_MAX_MESSAGES) : out;
}

export function titleFromMessages(messages: PersistedChatMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user' && m.content?.trim()) {
      const t = m.content.trim().replace(/\s+/g, ' ');
      return t.length > 72 ? t.slice(0, 72) + '…' : t;
    }
  }
  return 'Untitled chat';
}

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
  return pruneSessions([next, ...sessions.filter((s) => s.id !== next.id)], now);
}

/**
 * Per-user agent chat history on Firestore (same doc as the desktop IDE).
 */
export class ChatHistoryStore {
  private cache: PersistedChatSession[] = [];
  private loadedUid: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapped = false;

  constructor(private readonly getSession: () => OlkilSession | null) {}

  listSummaries(): ChatHistorySummary[] {
    return pruneSessions(this.cache).map(toSummary);
  }

  getSessionById(id: string): PersistedChatSession | undefined {
    return pruneSessions(this.cache).find((s) => s.id === id);
  }

  resetLocal() {
    this.cache = [];
    this.loadedUid = null;
    this.bootstrapped = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  async bootstrap(): Promise<ChatHistorySummary[]> {
    const session = this.getSession();
    const uid = session?.user?.uid;
    if (!uid) {
      this.resetLocal();
      return [];
    }
    if (this.bootstrapped && this.loadedUid === uid) return this.listSummaries();

    const token = await this.token();
    if (!token) {
      this.cache = [];
      this.loadedUid = uid;
      this.bootstrapped = true;
      return [];
    }

    try {
      const remote = await this.fetchDoc(token, uid);
      const pruned = pruneSessions(remote);
      this.cache = pruned;
      this.loadedUid = uid;
      this.bootstrapped = true;
      if (pruned.length !== remote.length) void this.flushNow(pruned);
    } catch {
      this.cache = [];
      this.loadedUid = uid;
      this.bootstrapped = true;
    }
    return this.listSummaries();
  }

  scheduleUpsert(session: PersistedChatSession): boolean {
    const user = this.getSession()?.user;
    if (!user?.uid || this.loadedUid !== user.uid) return false;
    if (!session.messages.length) return false;
    const now = Date.now();
    const next: PersistedChatSession = {
      ...session,
      messages: slimMessages(session.messages),
      title: session.title || titleFromMessages(session.messages),
      updatedAt: now,
      expiresAt: now + CHAT_HISTORY_TTL_MS,
    };
    if (!next.messages.some((m) => m.role === 'user')) return false;
    this.cache = upsertSession(this.cache, next, now);
    this.queueFlush();
    return true;
  }

  async flushNow(sessions = this.cache): Promise<void> {
    const session = this.getSession();
    const uid = session?.user?.uid;
    if (!uid) return;
    const token = await this.token();
    if (!token) return;
    const pruned = pruneSessions(sessions);
    this.cache = pruned;
    try {
      await this.putDoc(token, uid, pruned);
    } catch {
      /* history is optional */
    }
  }

  private queueFlush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushNow();
    }, CHAT_HISTORY_SAVE_DEBOUNCE_MS);
  }

  private async token(): Promise<string | null> {
    const session = this.getSession();
    if (!session) return null;
    const fresh = await refreshSession(session);
    return fresh?.idToken || null;
  }

  private async fetchDoc(token: string, uid: string): Promise<PersistedChatSession[]> {
    const res = await fetch(`https://firestore.googleapis.com/v1/${DOC_PATH(uid)}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('Firestore GET ' + res.status);
    const json = (await res.json()) as { fields?: Record<string, unknown> };
    const chats = decodeJs(json.fields?.chats);
    return Array.isArray(chats) ? (chats as PersistedChatSession[]) : [];
  }

  private async putDoc(token: string, uid: string, chats: PersistedChatSession[]): Promise<void> {
    const slim = chats.slice(0, CHAT_HISTORY_MAX).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      expiresAt: c.expiresAt,
      messages: c.messages,
    }));
    const body = JSON.stringify({
      fields: {
        chats: encodeJs(slim),
        updatedAt: encodeJs(Date.now()),
      },
    });
    const headers = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    };
    const patchUrl =
      `https://firestore.googleapis.com/v1/${DOC_PATH(uid)}` +
      `?updateMask.fieldPaths=chats&updateMask.fieldPaths=updatedAt`;
    let res = await fetch(patchUrl, { method: 'PATCH', headers, body });
    if (res.status === 404) {
      res = await fetch(`https://firestore.googleapis.com/v1/${DOC_PATH(uid)}`, {
        method: 'PATCH',
        headers,
        body,
      });
    }
    if (!res.ok) throw new Error('Firestore PATCH ' + res.status);
  }
}

function encodeJs(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeJs) } };
  if (typeof value === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = encodeJs(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function decodeJs(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, any>;
  if ('stringValue' in v) return v.stringValue as string;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue as number;
  if ('booleanValue' in v) return v.booleanValue as boolean;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return ((v.arrayValue?.values as unknown[]) || []).map(decodeJs);
  if ('mapValue' in v) {
    const fields = (v.mapValue?.fields || {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, nested] of Object.entries(fields)) out[k] = decodeJs(nested);
    return out;
  }
  return null;
}
