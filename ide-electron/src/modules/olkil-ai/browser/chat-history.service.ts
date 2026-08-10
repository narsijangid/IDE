import { Autowired, Injectable } from '@opensumi/di';
import { Emitter, Event } from '@opensumi/ide-core-common';
import { IOlkilAuthService, OLKIL_FIRESTORE_PROJECT } from '../../olkil-auth/common';
import {
  CHAT_HISTORY_MAX,
  CHAT_HISTORY_SAVE_DEBOUNCE_MS,
  CHAT_HISTORY_TTL_MS,
  ChatHistorySummary,
  PersistedChatSession,
  pruneSessions,
  toSummary,
  upsertSession,
} from '../common/chat-history';

const DOC_PATH = (uid: string) =>
  `projects/${OLKIL_FIRESTORE_PROJECT}/databases/(default)/documents/users/${encodeURIComponent(uid)}/data/chatHistory`;

/**
 * Per-user agent chat history on Firestore (single document).
 * Caps: 3 chats, 48h TTL. Debounced writes — never blocks the UI thread.
 */
@Injectable()
export class OlkilChatHistoryService {
  @Autowired(IOlkilAuthService)
  private readonly auth!: IOlkilAuthService;

  private cache: PersistedChatSession[] = [];
  private loadedUid: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveSeq = 0;
  private inflightWrite: Promise<void> | null = null;
  private bootstrapped = false;

  private readonly onDidChangeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  listSummaries(): ChatHistorySummary[] {
    return pruneSessions(this.cache).map(toSummary);
  }

  getSession(id: string): PersistedChatSession | undefined {
    return pruneSessions(this.cache).find((s) => s.id === id);
  }

  /** Load once per uid. Safe to call repeatedly. */
  async bootstrap(): Promise<ChatHistorySummary[]> {
    const user = this.auth.getUser();
    if (!user?.uid) {
      this.cache = [];
      this.loadedUid = null;
      this.onDidChangeEmitter.fire();
      return [];
    }
    if (this.bootstrapped && this.loadedUid === user.uid) {
      return this.listSummaries();
    }

    const token = await this.auth.getValidIdToken();
    if (!token) {
      this.cache = [];
      this.loadedUid = null;
      this.onDidChangeEmitter.fire();
      return [];
    }

    try {
      const remote = await this.fetchDoc(token, user.uid);
      const now = Date.now();
      const pruned = pruneSessions(remote, now);
      this.cache = pruned;
      this.loadedUid = user.uid;
      this.bootstrapped = true;
      this.onDidChangeEmitter.fire();

      // Persist prune (expired / >3) in background if anything dropped
      if (pruned.length !== remote.length) {
        void this.flushNow(pruned);
      }
    } catch {
      // Soft-fail: history is optional; never break the agent panel
      if (this.loadedUid !== user.uid) {
        this.cache = [];
        this.loadedUid = user.uid;
        this.bootstrapped = true;
        this.onDidChangeEmitter.fire();
      }
    }
    return this.listSummaries();
  }

  resetLocal() {
    this.cache = [];
    this.loadedUid = null;
    this.bootstrapped = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.onDidChangeEmitter.fire();
  }

  /**
   * Upsert a session into the local cache and schedule a Firebase write.
   * Returns whether the chat was kept (false if empty / signed out).
   */
  scheduleUpsert(session: PersistedChatSession): boolean {
    const user = this.auth.getUser();
    if (!user?.uid || this.loadedUid !== user.uid) {
      return false;
    }
    if (!session.messages.length) {
      return false;
    }
    const now = Date.now();
    const next: PersistedChatSession = {
      ...session,
      updatedAt: now,
      expiresAt: now + CHAT_HISTORY_TTL_MS,
    };
    this.cache = upsertSession(this.cache, next, now);
    this.onDidChangeEmitter.fire();
    this.queueFlush();
    return true;
  }

  /** Immediate prune+write (e.g. after delete). */
  async flushNow(sessions = this.cache): Promise<void> {
    const user = this.auth.getUser();
    if (!user?.uid) {
      return;
    }
    const token = await this.auth.getValidIdToken();
    if (!token) {
      return;
    }
    const pruned = pruneSessions(sessions);
    this.cache = pruned;
    const seq = ++this.saveSeq;
    const write = this.putDoc(token, user.uid, pruned).catch(() => undefined);
    this.inflightWrite = write;
    await write;
    if (seq === this.saveSeq) {
      this.inflightWrite = null;
    }
  }

  private queueFlush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushNow();
    }, CHAT_HISTORY_SAVE_DEBOUNCE_MS);
  }

  private async fetchDoc(token: string, uid: string): Promise<PersistedChatSession[]> {
    const url = `https://firestore.googleapis.com/v1/${DOC_PATH(uid)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`Firestore GET ${res.status}`);
    }
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
    const patchUrl =
      `https://firestore.googleapis.com/v1/${DOC_PATH(uid)}` +
      `?updateMask.fieldPaths=chats&updateMask.fieldPaths=updatedAt`;

    const body = JSON.stringify({
      fields: {
        chats: encodeJs(slim),
        updatedAt: encodeJs(Date.now()),
      },
    });

    let res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      cache: 'no-store',
    });

    // First write: document may not exist yet
    if (res.status === 404) {
      res = await fetch(`https://firestore.googleapis.com/v1/${DOC_PATH(uid)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        cache: 'no-store',
      });
    }

    if (!res.ok) {
      throw new Error(`Firestore PATCH ${res.status}`);
    }
  }
}

/** Minimal Firestore Value codec (only types we persist). */
function encodeJs(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeJs) } };
  }
  if (typeof value === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) {
        continue;
      }
      fields[k] = encodeJs(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function decodeJs(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, any>;
  if ('stringValue' in v) {
    return v.stringValue as string;
  }
  if ('integerValue' in v) {
    return Number(v.integerValue);
  }
  if ('doubleValue' in v) {
    return v.doubleValue as number;
  }
  if ('booleanValue' in v) {
    return v.booleanValue as boolean;
  }
  if ('nullValue' in v) {
    return null;
  }
  if ('arrayValue' in v) {
    const values = (v.arrayValue?.values as unknown[]) || [];
    return values.map(decodeJs);
  }
  if ('mapValue' in v) {
    const fields = (v.mapValue?.fields || {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, nested] of Object.entries(fields)) {
      out[k] = decodeJs(nested);
    }
    return out;
  }
  return null;
}
