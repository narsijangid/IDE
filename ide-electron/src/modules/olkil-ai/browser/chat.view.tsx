import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { createPortal } from 'react-dom';
import { useInjectable } from '@opensumi/ide-core-browser';
import {
  AgentTodoItem,
  ChatAttachment,
  FileChangeInfo,
  FileDiffLine,
  IOlkilChatService,
  IOlkilChatUiService,
  OllamaDownloadUiState,
  QueuedChatMessage,
  UiChatMessage,
} from '../common';
import {
  IOlkilVirtualOfficeService,
  VIRTUAL_OFFICE_ASSIGNEES,
  VirtualOfficeAssigneeId,
  VirtualOfficeWorkerBrief,
  basenamePath,
} from '../common/virtual-office';
import { MarkdownMessage } from './markdown';
import { LiveStatusBar, useLiveStatusLabel, useWorkspaceRoot } from './live-status-rotator';
import { CheckIcon, CopyIcon, RefreshIcon, SendIcon, ShieldStarIcon, StopIcon } from './icons';
import styles from './chat.view.module.less';
import logoUrl from './olkil-logo.png';

/** How long the composer confirms a finished turn before offering Send again. */
const DONE_HINT_MS = 1800;
const INPUT_MAX_HEIGHT = 168;

const LIVE_TEST_SUGGESTIONS = [
  'Test the application',
  'Login and test',
  'Test the workflow',
  'Find UI bugs and report them',
  'Verify the happy path end-to-end',
] as const;

function activityGlyph(kind: string, done?: boolean): string {
  if (done) {
    return '✓';
  }
  switch (kind) {
    case 'thinking':
      return '···';
    case 'reading':
      return '◎';
    case 'searching':
    case 'indexing':
      return '⌕';
    case 'editing':
      return '✎';
    case 'running':
      return '›';
    case 'browsing':
      return '◉';
    case 'todo':
      return '☰';
    case 'done':
      return '✓';
    default:
      return '·';
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

type ChatRow =
  | { type: 'message'; message: UiChatMessage }
  | { type: 'activity-group'; parent: UiChatMessage; children: UiChatMessage[] };

function clusterActivityRows(messages: UiChatMessage[]): ChatRow[] {
  const childrenByParent = new Map<string, UiChatMessage[]>();
  const childIds = new Set<string>();
  for (const m of messages) {
    const parentId = m.activity?.parentId;
    if (m.role === 'activity' && parentId) {
      const list = childrenByParent.get(parentId) || [];
      list.push(m);
      childrenByParent.set(parentId, list);
      childIds.add(m.id);
    }
  }
  const rows: ChatRow[] = [];
  for (const m of messages) {
    if (childIds.has(m.id)) continue;
    if (m.role === 'activity' && m.activity) {
      const key = m.activity.groupId || m.activity.toolCallId || m.id;
      const children = childrenByParent.get(key) || childrenByParent.get(m.id) || [];
      if (children.length > 0) {
        rows.push({ type: 'activity-group', parent: m, children });
        continue;
      }
    }
    rows.push({ type: 'message', message: m });
  }
  return rows;
}

function ExplorationGroup({
  parent,
  items,
  onOpenPath,
}: {
  parent: UiChatMessage;
  items: UiChatMessage[];
  onOpenPath: (path: string) => void;
}) {
  const a = parent.activity;
  const [open, setOpen] = useState(false);
  if (!a) return null;
  const files =
    a.filesExplored ?? new Set(items.map((c) => c.activity?.filePath).filter(Boolean)).size;
  const searches =
    a.searchCount ?? items.filter((c) => c.activity?.kind === 'searching').length;
  const label =
    a.done && (files || searches)
      ? a.label || `Explored ${files} files, ${searches} searches`
      : a.label;
  return (
    <div className={`${styles.activityGroup} ${a.done ? styles.activityDone : styles.activityLive}`}>
      <button type="button" className={styles.activityGroupHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.activityGlyph} aria-hidden>
          {activityGlyph(a.kind, a.done)}
        </span>
        <span className={styles.activityLabel}>{label}</span>
        <span className={styles.activityGroupMeta}>
          {files ? `${files} files` : ''}
          {files && searches ? ', ' : ''}
          {searches ? `${searches} searches` : ''}
        </span>
        <span className={`${styles.activityChevron} ${open ? styles.activityChevronOpen : ''}`}>▸</span>
      </button>
      {open ? (
        <div className={styles.activityGroupBody}>
          {items.map((child) => (
            <ActivityRow key={child.id} message={child} onOpenPath={onOpenPath} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityRow({
  message,
  onOpenPath,
}: {
  message: UiChatMessage;
  onOpenPath: (path: string) => void;
}) {
  const a = message.activity;
  const [open, setOpen] = useState(false);
  if (!a) {
    return null;
  }
  const previewRaw = a.resultPreview || '';
  const previewIsJunk = /DSML|tool_calls|｜DSML｜|<invoke\b|parameter\s+name=/i.test(previewRaw);
  const safePreview = previewIsJunk ? '' : previewRaw;
  const argsIsJunk =
    !a.argsPreview ||
    /"query"\s*:\s*""|"path"\s*:\s*""|string=|"true"/i.test(a.argsPreview) ||
    a.argsPreview.trim().length < 5;
  const safeArgs = argsIsJunk ? '' : a.argsPreview;
  const expandable = Boolean(
    safePreview || safeArgs || a.command || (a.kind === 'running' && a.resultPreview),
  );
  // Don't show a dead "open" chip for missing/junk paths
  const openPath =
    a.filePath && !/^(string=|true|false)$/i.test(a.filePath) && a.filePath.length > 2
      ? a.filePath
      : undefined;
  return (
    <div
      className={`${styles.activityCard} ${a.done ? styles.activityDone : styles.activityLive} ${
        styles[`activity_${a.kind}`] || ''
      }`}
    >
      <button
        type="button"
        className={styles.activityHeader}
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
      >
        <span className={styles.activityGlyph} aria-hidden>
          {activityGlyph(a.kind, a.done)}
        </span>
        <span className={styles.activityLabel}>{a.label}</span>
        {a.exitCode != null ? (
          <span className={a.exitCode === 0 ? styles.activityOk : styles.activityFail}>
            exit {a.exitCode}
          </span>
        ) : null}
        {openPath ? (
          <span
            className={styles.activityPathBtn}
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenPath(openPath);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onOpenPath(openPath);
              }
            }}
          >
            open
          </span>
        ) : null}
        {expandable ? (
          <span className={`${styles.activityChevron} ${open ? styles.activityChevronOpen : ''}`}>
            ▸
          </span>
        ) : null}
      </button>
      {open ? (
        <div className={styles.activityBody}>
          {a.command ? (
            <div className={styles.activityCmd}>
              <code>$ {a.command}</code>
              <button type="button" className={styles.miniBtn} onClick={() => void copyText(a.command || '')}>
                Copy
              </button>
            </div>
          ) : null}
          {safeArgs ? (
            <pre className={styles.activityPre}>
              <div className={styles.activityPreLabel}>Args</div>
              {safeArgs}
            </pre>
          ) : null}
          {safePreview ? (
            <pre className={styles.activityPre}>
              <div className={styles.activityPreLabel}>
                {a.kind === 'thinking' ? 'Thought' : 'Output'}
              </div>
              {safePreview}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TodosCard({ todos }: { todos: AgentTodoItem[] }) {
  if (!todos?.length) {
    return null;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className={styles.todosCard}>
      <div className={styles.todosHeader}>
        <span>Todos</span>
        <span className={styles.todosCount}>
          {done}/{todos.length}
        </span>
      </div>
      <ul className={styles.todosList}>
        {todos.map((t) => (
          <li key={t.id} className={`${styles.todoItem} ${styles[`todo_${t.status}`] || ''}`}>
            <span className={styles.todoMark} aria-hidden>
              {t.status === 'completed'
                ? '✓'
                : t.status === 'in_progress'
                  ? '●'
                  : t.status === 'cancelled'
                    ? '–'
                    : '○'}
            </span>
            <span className={styles.todoText}>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function extBadge(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!ext) {
    return 'FILE';
  }
  if (ext === 'tsx' || ext === 'ts') {
    return 'TS';
  }
  if (ext === 'jsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return 'JS';
  }
  if (ext === 'json') {
    return '{}';
  }
  if (ext === 'css' || ext === 'less' || ext === 'scss') {
    return 'CSS';
  }
  if (ext === 'md') {
    return 'MD';
  }
  if (ext === 'py') {
    return 'PY';
  }
  return ext.slice(0, 3).toUpperCase();
}

function DiffPreview({ lines }: { lines: FileDiffLine[] }) {
  return (
    <div className={styles.diffBody}>
      {lines.map((line, i) => {
        if (line.type === 'gap') {
          return (
            <div key={`g${i}`} className={styles.diffGap}>
              <span className={styles.gapChevron}>▾</span>
            </div>
          );
        }
        const rowClass =
          line.type === 'add'
            ? styles.diffAdd
            : line.type === 'del'
              ? styles.diffDel
              : styles.diffCtx;
        const mark = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
        return (
          <div key={`l${i}`} className={`${styles.diffLine} ${rowClass}`}>
            <span className={styles.diffLn}>{line.lineNumber ?? ''}</span>
            <span className={styles.diffMark}>{mark}</span>
            <span className={styles.diffText}>{line.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

function FileChangeCard({
  change,
  onAccept,
  onRevert,
  onOpen,
  onAcceptHunk,
  onRejectHunk,
}: {
  change: FileChangeInfo;
  onAccept: (id: string) => void;
  onRevert: (id: string) => void;
  onOpen: (id: string) => void;
  onAcceptHunk?: (changeId: string, hunkId: string) => void;
  onRejectHunk?: (changeId: string, hunkId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const title =
    change.kind === 'rename'
      ? `${change.displayName} → ${change.newDisplayName || ''}`
      : change.kind === 'delete'
        ? `Deleted ${change.displayName}`
        : change.displayName;
  const pending = change.status === 'pending';
  const previewLines = expanded ? change.preview : change.preview?.slice(0, 16);

  return (
    <div className={`${styles.fileCard} ${pending ? styles.fileCardShine : ''} ${styles[`status_${change.status}`] || ''}`}>
      <div className={styles.fileCardHeader}>
        <span className={styles.fileBadge}>{extBadge(change.newDisplayName || change.displayName)}</span>
        <button
          type="button"
          className={styles.fileNameBtn}
          title={`Open ${change.newPath || change.path}`}
          onClick={() => onOpen(change.id)}
        >
          {title}
        </button>
        <span className={styles.fileStats}>
          {change.additions > 0 ? <span className={styles.statAdd}>+{change.additions}</span> : null}
          {change.deletions > 0 ? <span className={styles.statDel}>−{change.deletions}</span> : null}
          {change.editCount && change.editCount > 1 ? (
            <span className={styles.editCount}>{change.editCount} edits</span>
          ) : null}
        </span>
      </div>

      {previewLines?.length ? <DiffPreview lines={previewLines} /> : null}
      {change.preview && change.preview.length > 16 ? (
        <button type="button" className={styles.expandDiffBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse diff' : 'Show full diff'}
        </button>
      ) : null}

      {pending && change.hunks && change.hunks.length > 1 ? (
        <div className={styles.hunkList}>
          {change.hunks.map((h) => (
            <div key={h.id} className={`${styles.hunkRow} ${styles[`hunk_${h.status}`] || ''}`}>
              <span className={styles.hunkTitle}>
                {h.title}
                <span className={styles.hunkStats}>
                  {h.additions ? ` +${h.additions}` : ''}
                  {h.deletions ? ` −${h.deletions}` : ''}
                </span>
              </span>
              {h.status === 'pending' ? (
                <span className={styles.hunkActions}>
                  <button type="button" className={styles.acceptBtn} onClick={() => onAcceptHunk?.(change.id, h.id)}>
                    Keep
                  </button>
                  <button type="button" className={styles.revertBtn} onClick={() => onRejectHunk?.(change.id, h.id)}>
                    Undo
                  </button>
                </span>
              ) : (
                <span className={styles.statusLabel}>{h.status}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {change.summary ? <div className={styles.fileSummary}>{change.summary}</div> : null}

      <div className={styles.fileCardActions}>
        {pending ? (
          <>
            <button type="button" className={styles.acceptBtn} onClick={() => onAccept(change.id)}>
              Accept
            </button>
            <button type="button" className={styles.revertBtn} onClick={() => onRevert(change.id)}>
              Revert
            </button>
          </>
        ) : (
          <span className={styles.statusLabel}>
            {change.status === 'accepted' ? 'Accepted' : 'Reverted'}
          </span>
        )}
      </div>
    </div>
  );
}

export interface OlkilAiChatViewProps {
  /**
   * Set while the panel is folded away. The view stays mounted (draft text and
   * scroll position survive) but stops mirroring service state, so a streaming
   * reply costs nothing until the panel comes back.
   */
  dormant?: boolean;
}

export const OlkilAiChatView = ({ dormant = false }: OlkilAiChatViewProps) => {
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  const chatUi = useInjectable<IOlkilChatUiService>(IOlkilChatUiService);
  const virtualOffice = useInjectable<IOlkilVirtualOfficeService>(IOlkilVirtualOfficeService);
  const [messages, setMessages] = useState<UiChatMessage[]>(chat.messages);
  const [status, setStatus] = useState(chat.status);
  const [busy, setBusy] = useState(chat.busy);
  const [modelId, setModelId] = useState(chat.modelId);
  const [models, setModels] = useState(chat.models);
  const [chatMode, setChatMode] = useState(chat.chatMode);
  const [liveTesting, setLiveTesting] = useState(chat.liveTesting);
  const [ollamaDownload, setOllamaDownload] = useState<OllamaDownloadUiState>(chat.ollamaDownload);
  const [pendingCount, setPendingCount] = useState(chat.pendingChanges.length);
  const [queue, setQueue] = useState<QueuedChatMessage[]>(chat.queuedMessages);
  const [voActive, setVoActive] = useState(virtualOffice.active);
  const [voAssignee, setVoAssignee] = useState<VirtualOfficeAssigneeId>(virtualOffice.assigneeId);
  const [voBrief, setVoBrief] = useState<VirtualOfficeWorkerBrief | null>(null);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionItems, setMentionItems] = useState<ChatAttachment[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionSeq = useRef(0);
  const stickBottomRef = useRef(true);
  const lastInspectedRef = useRef<string | null>(null);

  const sync = useCallback(() => {
    setMessages([...chat.messages]);
    setStatus(chat.status);
    setBusy(chat.busy);
    setModelId(chat.modelId);
    setModels([...chat.models]);
    setChatMode(chat.chatMode);
    setLiveTesting(chat.liveTesting);
    setOllamaDownload({ ...chat.ollamaDownload });
    setPendingCount(chat.pendingChanges.length);
    setQueue([...chat.queuedMessages]);
  }, [chat]);

  const syncVo = useCallback(() => {
    setVoActive(virtualOffice.active);
    setVoAssignee(virtualOffice.assigneeId);
    const id = virtualOffice.inspectedWorkerId;
    setVoBrief(id ? virtualOffice.getWorkerBrief(id) : null);
    if (id && id !== lastInspectedRef.current) {
      lastInspectedRef.current = id;
      try {
        chatUi.open();
        chatUi.setPinned(true);
      } catch {
        // optional
      }
    }
    if (!id) {
      lastInspectedRef.current = null;
    }
  }, [virtualOffice, chatUi]);

  const dormantRef = useRef(dormant);
  const staleRef = useRef(false);
  dormantRef.current = dormant;

  useEffect(() => {
    chat.init();
    const d = chat.onDidChange(() => {
      if (dormantRef.current) {
        staleRef.current = true;
        return;
      }
      startTransition(sync);
    });
    return () => d.dispose();
  }, [chat, sync]);

  useEffect(() => {
    syncVo();
    const d = virtualOffice.onDidChange(() => {
      if (dormantRef.current) {
        return;
      }
      syncVo();
    });
    return () => d.dispose();
  }, [virtualOffice, syncVo]);

  // Catch up in one pass when the panel is brought back.
  useEffect(() => {
    if (!dormant && staleRef.current) {
      staleRef.current = false;
      sync();
      syncVo();
    }
  }, [dormant, sync, syncVo]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || dormant) {
      return;
    }
    if (stickBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status, dormant]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const addAttachment = useCallback((att: ChatAttachment) => {
    setAttachments((prev) => {
      if (prev.some((p) => p.path.toLowerCase() === att.path.toLowerCase())) {
        return prev;
      }
      return [...prev, att].slice(0, 12);
    });
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  // Debounced @mention search
  useEffect(() => {
    if (!mentionOpen) {
      return;
    }
    const seq = ++mentionSeq.current;
    const t = setTimeout(async () => {
      const items = await chat.listMentionCandidates(mentionQuery, 30);
      if (seq === mentionSeq.current) {
        setMentionItems(items);
        setMentionIndex(0);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [chat, mentionOpen, mentionQuery]);

  const insertMention = useCallback(
    (item: ChatAttachment) => {
      addAttachment(item);
      const el = inputRef.current;
      const value = input;
      const cursor = el?.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const at = before.lastIndexOf('@');
      const next =
        at >= 0 ? `${before.slice(0, at)}@${item.name} ${after}` : `${before}@${item.name} ${after}`;
      setInput(next);
      setMentionOpen(false);
      setMentionQuery('');
      requestAnimationFrame(() => {
        const pos = (at >= 0 ? at : cursor) + item.name.length + 2;
        el?.focus();
        el?.setSelectionRange(pos, pos);
      });
    },
    [addAttachment, input],
  );

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) {
      return;
    }
    setInput('');
    const atts = [...attachments];
    setAttachments([]);
    setMentionOpen(false);
    stickBottomRef.current = true;
    await chat.send(text, atts);
    inputRef.current?.focus();
  }, [attachments, chat, input]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && mentionItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionItems[mentionIndex] || mentionItems[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const cursor = e.target.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const m = /(^|[\s])@([^\s@]*)$/.exec(before);
    if (m) {
      setMentionOpen(true);
      setMentionQuery(m[2] || '');
    } else {
      setMentionOpen(false);
      setMentionQuery('');
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []) as File[];
    for (const f of files) {
      const p = (f as any).path as string;
      const isImage = (f.type || '').startsWith('image/');
      if (isImage) {
        const reader = new FileReader();
        reader.onload = () => {
          addAttachment({
            path: p || `image:${f.name}`,
            name: f.name || 'image',
            kind: 'image',
            dataUrl: String(reader.result || ''),
            mimeType: f.type,
          });
        };
        reader.readAsDataURL(f);
        continue;
      }
      if (!p) {
        continue;
      }
      const name = p.replace(/\\/g, '/').split('/').pop() || p;
      const isDir = !name.includes('.') && !(f as any).type;
      addAttachment({
        path: p,
        name: name,
        kind: isDir ? 'folder' : 'file',
      });
    }
    // Also support text/uri-list (explorer drops)
    const uriList = e.dataTransfer?.getData('text/uri-list') || '';
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      try {
        const u = new URL(trimmed);
        if (u.protocol !== 'file:') {
          continue;
        }
        let p = decodeURIComponent(u.pathname);
        if (/^\/[A-Za-z]:\//.test(p)) {
          p = p.slice(1);
        }
        p = p.replace(/\//g, '\\');
        const name = p.replace(/\\/g, '/').split('/').pop() || p;
        addAttachment({ path: p, name, kind: 'file' });
      } catch {
        // ignore
      }
    }
  };

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [liveTestOpen, setLiveTestOpen] = useState(false);
  const [liveTestPrompt, setLiveTestPrompt] = useState('');
  const liveTestInputRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const selectedModel = models.find((m) => m.id === modelId) || models[0];
  const modelSelectDisabled =
    busy || ollamaDownload.phase === 'downloading' || ollamaDownload.phase === 'starting';

  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    const onDoc = (ev: MouseEvent) => {
      if (!modelMenuRef.current?.contains(ev.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!liveTestOpen) {
      return;
    }
    const t = window.setTimeout(() => {
      liveTestInputRef.current?.focus();
      liveTestInputRef.current?.select();
    }, 40);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setLiveTestOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [liveTestOpen]);

  const openLiveTestModal = useCallback(() => {
    setLiveTestPrompt(input.trim() || 'Test the application');
    setLiveTestOpen(true);
  }, [input]);

  const runLiveTest = useCallback(() => {
    const goal = liveTestPrompt.trim();
    if (!goal || busy) {
      return;
    }
    setLiveTestOpen(false);
    setInput('');
    void chat.startLiveTest(goal);
  }, [liveTestPrompt, busy, chat]);

  const renderModelLabel = (m?: { displayName?: string; badge?: string; label: string }) => {
    if (!m) {
      return null;
    }
    const name = m.displayName || m.label;
    const badge = m.badge;
    const badgeClass =
      badge === 'FREE' ? styles.modelBadgeFree : badge === 'LOCAL' ? styles.modelBadgeLocal : styles.modelBadge;
    return (
      <>
        <span className={styles.modelName}>{name}</span>
        {badge ? <span className={badgeClass}>{badge}</span> : null}
      </>
    );
  };

  // Grow the composer with its content instead of a fixed 3-row box.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || dormant) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [input, dormant]);

  const [turnDone, setTurnDone] = useState(false);
  const wasBusy = useRef(busy);

  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!finished) {
      return;
    }
    setTurnDone(true);
    const timer = window.setTimeout(() => setTurnDone(false), DONE_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  const rows = useMemo(() => clusterActivityRows(messages), [messages]);
  const ollamaBlocked =
    ollamaDownload.phase === 'needs_download' ||
    ollamaDownload.phase === 'starting' ||
    ollamaDownload.phase === 'downloading' ||
    ollamaDownload.phase === 'paused' ||
    ollamaDownload.phase === 'error';
  const canCompose = !ollamaBlocked && (Boolean(input.trim()) || attachments.length > 0);
  // While busy: Enter queues; Stop button stays primary
  const canSend = canCompose && (!busy || true);
  const sendMode = busy ? 'stop' : turnDone && !canCompose ? 'done' : 'send';
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !messages[i].pending && messages[i].content) {
        return messages[i].id;
      }
    }
    return null;
  }, [messages]);

  const workspaceRoot = useWorkspaceRoot();
  const liveActivityLabel = useMemo(() => {
    const live = [...messages]
      .reverse()
      .find((m) => m.role === 'activity' && m.activity && !m.activity.done);
    return live?.activity?.label;
  }, [messages]);
  const liveStatusLabel = useLiveStatusLabel({
    active: busy,
    status,
    activityLabel: liveActivityLabel,
    workspaceRoot,
  });

  const formatGb = (bytes?: number, fallbackGb?: number) => {
    if (typeof bytes === 'number' && bytes > 0) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (typeof fallbackGb === 'number') {
      return `~${fallbackGb} GB`;
    }
    return '';
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.modeToggle} role="tablist" aria-label="Chat mode">
            <button
              type="button"
              role="tab"
              aria-selected={chatMode === 'agent'}
              className={`${styles.modeBtn} ${chatMode === 'agent' ? styles.modeBtnActive : ''}`}
              disabled={busy}
              onClick={() => chat.setChatMode('agent')}
              title="Act mode: gather context, plan, then implement with tools"
            >
              Agent
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={chatMode === 'ask'}
              className={`${styles.modeBtn} ${chatMode === 'ask' ? styles.modeBtnActive : ''}`}
              disabled={busy}
              onClick={() => chat.setChatMode('ask')}
              title="Ask mode: read-only answers, no file edits"
            >
              Ask
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={chatMode === 'plan'}
              className={`${styles.modeBtn} ${chatMode === 'plan' ? styles.modeBtnActive : ''}`}
              disabled={busy}
              onClick={() => chat.setChatMode('plan')}
              title="Plan mode: explore and outline — switch to Agent to implement"
            >
              Plan
            </button>
          </div>
          <button
            type="button"
            className={styles.liveTestBtn}
            disabled={busy || ollamaBlocked}
            title="Open live browser test — choose what to verify"
            onClick={openLiveTestModal}
          >
            Live Test
          </button>
          <div className={styles.modelPicker} ref={modelMenuRef}>
            <button
              type="button"
              className={styles.modelSelect}
              disabled={modelSelectDisabled}
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              title="Select AI model"
              onClick={() => {
                if (!modelSelectDisabled) {
                  setModelMenuOpen((v) => !v);
                }
              }}
            >
              <span className={styles.modelSelectValue}>{renderModelLabel(selectedModel)}</span>
              <span className={styles.modelSelectChevron} aria-hidden>
                ▾
              </span>
            </button>
            {modelMenuOpen ? (
              <div className={styles.modelMenu} role="listbox" aria-label="AI models">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === modelId}
                    className={`${styles.modelOption} ${m.id === modelId ? styles.modelOptionActive : ''}`}
                    onClick={() => {
                      chat.setModel(m.id);
                      setModelMenuOpen(false);
                    }}
                  >
                    {renderModelLabel(m)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {voActive && voBrief ? (
        <div className={styles.voInspect} data-status={voBrief.deskStatus}>
          <div className={styles.voInspectTop}>
            <div className={styles.voInspectIdentity}>
              <span className={styles.voInspectAvatar} aria-hidden>
                {(voBrief.workerName[0] || '?').toUpperCase()}
              </span>
              <div className={styles.voInspectMeta}>
                <div className={styles.voInspectName}>
                  {voBrief.workerName}
                  <span className={styles.voInspectRole}>{voBrief.role}</span>
                </div>
                <div className={styles.voInspectStatus}>
                  {voBrief.deskStatus === 'working'
                    ? voBrief.task?.liveStatus || 'Working'
                    : voBrief.deskStatus === 'done'
                      ? 'Completed'
                      : voBrief.deskStatus === 'error'
                        ? 'Failed'
                        : 'Idle — ready for a task'}
                </div>
              </div>
            </div>
            <button
              type="button"
              className={styles.voInspectClose}
              title="Close inspect"
              onClick={() => virtualOffice.clearInspect()}
            >
              ×
            </button>
          </div>

          {voBrief.task ? (
            <>
              <div className={styles.voInspectTask}>{voBrief.task.title}</div>

              {voBrief.task.files.length > 0 ? (
                <div className={styles.voInspectSection}>
                  <div className={styles.voInspectSectionLabel}>Files touched</div>
                  <div className={styles.voInspectFiles}>
                    {voBrief.task.files.slice(0, 8).map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        className={styles.voInspectFile}
                        title={f.path}
                        onClick={() => void chat.openPath(f.path)}
                      >
                        <span className={styles.voInspectFileKind}>{f.kind}</span>
                        {basenamePath(f.path)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {voBrief.task.activities.length > 0 ? (
                <div className={styles.voInspectSection}>
                  <div className={styles.voInspectSectionLabel}>Live activity</div>
                  <ul className={styles.voInspectActs}>
                    {voBrief.task.activities.slice(-6).map((a) => (
                      <li key={a.id} className={a.done ? styles.voInspectActDone : undefined}>
                        {a.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {voBrief.task.summary && voBrief.task.status !== 'running' ? (
                <p className={styles.voInspectSummary}>{voBrief.task.summary.slice(0, 360)}</p>
              ) : null}

              {voBrief.task.error ? (
                <p className={styles.voInspectError}>{voBrief.task.error}</p>
              ) : null}

              {voBrief.task.status === 'running' ? (
                <button
                  type="button"
                  className={styles.voInspectStop}
                  onClick={() => void virtualOffice.cancelTask(voBrief.task!.id)}
                >
                  Stop {voBrief.workerName}
                </button>
              ) : null}
            </>
          ) : (
            <p className={styles.voInspectEmpty}>
              No active task. Select {voBrief.workerName} in Assign to, then send a prompt.
            </p>
          )}
        </div>
      ) : null}

      {ollamaDownload.phase === 'needs_download' || ollamaDownload.phase === 'error' ? (
        <div className={styles.ollamaBanner}>
          <div className={styles.ollamaBannerText}>
            <strong>Ollama model required</strong>
            <span>
              {ollamaDownload.message ||
                `Download ${ollamaDownload.model || 'this model'} to your computer before chatting.`}
            </span>
            {ollamaDownload.approxSizeGb ? (
              <span className={styles.ollamaSize}>
                Approx size: ~{ollamaDownload.approxSizeGb} GB (one-time download)
              </span>
            ) : null}
            {ollamaDownload.error ? (
              <span className={styles.ollamaError}>{ollamaDownload.error}</span>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.ollamaDownloadBtn}
            disabled={busy}
            onClick={() => void chat.startOllamaDownload()}
          >
            Download Ollama model
          </button>
        </div>
      ) : null}

      {ollamaDownload.phase === 'starting' ||
      ollamaDownload.phase === 'downloading' ||
      ollamaDownload.phase === 'paused' ? (
        <div
          className={styles.ollamaBanner}
          data-active={ollamaDownload.phase !== 'paused' ? 'true' : 'paused'}
        >
          <div className={styles.ollamaBannerText}>
            <strong>
              {ollamaDownload.phase === 'starting'
                ? 'Starting Ollama…'
                : ollamaDownload.phase === 'paused'
                  ? `Paused — ${ollamaDownload.model || 'Ollama model'}`
                  : `Downloading ${ollamaDownload.model || 'Ollama model'}…`}
            </strong>
            <span>{ollamaDownload.message}</span>
            <div className={styles.ollamaProgressTrack} aria-hidden>
              <div
                className={styles.ollamaProgressFill}
                style={{ width: `${Math.max(0, Math.min(100, ollamaDownload.percent || 0))}%` }}
              />
            </div>
            <div className={styles.ollamaProgressMeta}>
              <span>{Math.max(0, Math.min(100, ollamaDownload.percent || 0))}%</span>
              <span>
                {formatGb(ollamaDownload.completedBytes)}
                {ollamaDownload.totalBytes
                  ? ` / ${formatGb(ollamaDownload.totalBytes)}`
                  : ollamaDownload.approxSizeGb
                    ? ` / ~${ollamaDownload.approxSizeGb} GB`
                    : ''}
              </span>
            </div>
          </div>
          <div className={styles.ollamaActions}>
            {ollamaDownload.phase === 'paused' ? (
              <button
                type="button"
                className={styles.ollamaDownloadBtn}
                disabled={busy}
                onClick={() => void chat.startOllamaDownload()}
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                className={styles.ollamaSecondaryBtn}
                disabled={busy || ollamaDownload.phase === 'starting'}
                onClick={() => void chat.pauseOllamaDownload()}
              >
                Pause
              </button>
            )}
            <button
              type="button"
              className={styles.ollamaCancelBtn}
              disabled={busy}
              onClick={() => void chat.cancelOllamaDownload()}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {ollamaDownload.phase === 'ready' && ollamaDownload.model ? (
        <div className={styles.ollamaReady}>
          Local Ollama ready — {ollamaDownload.model} (100%)
        </div>
      ) : null}

      {pendingCount > 0 ? (
        <div className={styles.reviewBar}>
          <span className={styles.reviewLabel}>
            {pendingCount} pending change{pendingCount === 1 ? '' : 's'}
          </span>
          <button type="button" className={styles.acceptBtn} onClick={() => chat.acceptAllPending()}>
            Accept all
          </button>
          <button type="button" className={styles.revertBtn} onClick={() => chat.revertAllPending()}>
            Revert all
          </button>
        </div>
      ) : null}

      <div className={styles.list} ref={listRef} onScroll={onListScroll}>
        {rows.map((row) => {
          if (row.type === 'activity-group') {
            return (
              <div key={row.parent.id} className={styles.rowLeft}>
                <ExplorationGroup
                  parent={row.parent}
                  items={row.children}
                  onOpenPath={(p) => void chat.openPath(p)}
                />
              </div>
            );
          }
          const m = row.message;
          if (m.role === 'activity' && m.activity) {
            return (
              <div key={m.id} className={styles.rowLeft}>
                <ActivityRow message={m} onOpenPath={(p) => void chat.openPath(p)} />
              </div>
            );
          }

          if (m.role === 'todos' && m.todos?.length) {
            return (
              <div key={m.id} className={styles.rowLeft}>
                <TodosCard todos={m.todos} />
              </div>
            );
          }

          if (m.role === 'file_change' && m.fileChange) {
            return (
              <div key={m.id} className={styles.rowLeft}>
                <FileChangeCard
                  change={m.fileChange}
                  onAccept={(id) => chat.acceptChange(id)}
                  onRevert={(id) => chat.revertChange(id)}
                  onOpen={(id) => chat.openChangeFile(id)}
                  onAcceptHunk={(cid, hid) => void chat.acceptHunk(cid, hid)}
                  onRejectHunk={(cid, hid) => void chat.rejectHunk(cid, hid)}
                />
              </div>
            );
          }

          // Hide empty pending bubble until final/streamed text arrives (Cursor timeline)
          if (m.role === 'assistant' && m.pending && !(m.content || '').trim()) {
            return null;
          }
          // Never show raw DSML / tool XML in the answer bubble
          const rawContent = m.content || '';
          const looksToolDump =
            /DSML|tool_calls|｜DSML｜|<invoke\b|parameter\s+name=/i.test(rawContent);
          if (m.role === 'assistant' && looksToolDump) {
            if (m.pending) {
              return null;
            }
            // Final message somehow still garbage — show friendly placeholder
            return (
              <div key={m.id} className={`${styles.row} ${styles.rowLeft}`}>
                <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
                  <div className={styles.roleRow}>
                    <img className={styles.roleAvatar} src={logoUrl} alt="" width={14} height={14} draggable={false} />
                    <span className={styles.role}>
                      {chatMode === 'plan' ? 'Plan' : chatMode === 'ask' ? 'Ask' : 'Agent'}
                    </span>
                  </div>
                  <div className={styles.content}>Working on your answer…</div>
                </div>
              </div>
            );
          }

          const isUser = m.role === 'user';
          const isSystem = m.role === 'system' || m.role === 'status';
          const showActions = !isSystem && !(m.pending && isUser);
          return (
            <div
              key={m.id}
              className={`${styles.row} ${isUser ? styles.rowRight : styles.rowLeft} ${
                isSystem ? styles.rowCenter : ''
              }`}
            >
              <div
                className={`${styles.bubble} ${styles[m.role] || ''} ${
                  isUser ? styles.bubbleUser : styles.bubbleAssistant
                } ${isUser && m.liveTest ? styles.bubbleUserLiveTest : ''} ${
                  m.pending ? styles.bubblePending : ''
                }`}
              >
                {!isUser && !isSystem ? (
                  <div className={styles.roleRow}>
                    <img className={styles.roleAvatar} src={logoUrl} alt="" width={14} height={14} draggable={false} />
                    <span className={styles.role}>
                      {chatMode === 'plan' ? 'Plan' : chatMode === 'ask' ? 'Ask' : 'Agent'}
                    </span>
                  </div>
                ) : null}
                {isUser && m.liveTest ? (
                  <div className={styles.userLiveTestLayout}>
                    <div className={styles.userLiveTestBody}>
                      <div className={styles.content}>{m.content || (m.pending ? '…' : '')}</div>
                    </div>
                    <span
                      className={`${styles.testingBadgeOnPrompt} ${
                        liveTesting ? styles.testingBadgeOnPromptLive : ''
                      }`}
                      title="Live browser test"
                    >
                      <ShieldStarIcon size={11} className={styles.testingBadgeIcon} />
                      Testing
                    </span>
                  </div>
                ) : isUser || isSystem ? (
                  <div className={styles.content}>{m.content || (m.pending ? '…' : '')}</div>
                ) : (
                  <MarkdownMessage
                    className={styles.contentMd}
                    text={m.content || (m.pending ? '…' : '')}
                    onOpenPath={(p, line) => void chat.openPath(p, line)}
                  />
                )}
                {isUser && m.attachments?.length ? (
                  <div className={styles.msgAttachRow}>
                    {m.attachments.map((a) => (
                      <button
                        key={a.path}
                        type="button"
                        className={styles.msgAttachChip}
                        title={a.path}
                        onClick={() => void chat.openPath(a.path)}
                      >
                        @{a.name}
                      </button>
                    ))}
                  </div>
                ) : null}
                {m.suggestions?.length ? (
                  <div className={styles.suggestRow}>
                    {m.suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={styles.suggestChip}
                        disabled={busy}
                        onClick={() => void chat.send(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                ) : null}
                {showActions ? (
                  <div className={styles.msgActions}>
                    <button
                      type="button"
                      className={styles.msgActionBtn}
                      title="Copy"
                      onClick={() => void copyText(m.content || '')}
                    >
                      <CopyIcon size={12} />
                    </button>
                    {!isUser && m.id === lastAssistantId && !busy ? (
                      <button
                        type="button"
                        className={styles.msgActionBtn}
                        title="Regenerate"
                        onClick={() => void chat.regenerate()}
                      >
                        <RefreshIcon size={12} />
                      </button>
                    ) : null}
                    {isUser && !busy ? (
                      <button
                        type="button"
                        className={styles.msgActionBtn}
                        title="Edit & resend"
                        onClick={() => {
                          const next = window.prompt('Edit message', m.content || '');
                          if (next != null && next.trim()) {
                            void chat.editAndResend(m.id, next.trim());
                          }
                        }}
                      >
                        ✎
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {busy ? <LiveStatusBar label={liveStatusLabel} /> : status ? (
          <div className={styles.status}>{status}</div>
        ) : null}
      </div>

      <div
        className={`${styles.composer} ${dragOver ? styles.composerDrop : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {queue.length ? (
          <div className={styles.queueRow}>
            {queue.map((q) => (
              <span key={q.id} className={styles.queueChip} title={q.text}>
                <span className={styles.queueLabel}>Queued</span>
                <span className={styles.queueText}>{q.text.slice(0, 48)}</span>
                <button
                  type="button"
                  className={styles.attachRemove}
                  onClick={() => chat.cancelQueued(q.id)}
                  aria-label="Cancel queued message"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {voActive ? (
          <div className={styles.voBar}>
            <label className={styles.voLabel} htmlFor="olkil-vo-assignee">
              Assign to
            </label>
            <select
              id="olkil-vo-assignee"
              className={styles.voSelect}
              value={voAssignee}
              onChange={(e) =>
                virtualOffice.setAssignee(e.target.value as VirtualOfficeAssigneeId)
              }
            >
              {VIRTUAL_OFFICE_ASSIGNEES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.role}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {attachments.length ? (
          <div className={styles.attachRow}>
            {attachments.map((a) => (
              <span key={a.path} className={styles.attachChip} title={a.path}>
                <span className={styles.attachKind}>{a.kind === 'folder' ? 'DIR' : 'FILE'}</span>
                <span className={styles.attachName}>{a.name}</span>
                <button
                  type="button"
                  className={styles.attachRemove}
                  onClick={() => removeAttachment(a.path)}
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {mentionOpen && mentionItems.length ? (
          <div className={styles.mentionMenu} role="listbox">
            {mentionItems.map((item, i) => (
              <button
                key={`${item.kind}:${item.path}`}
                type="button"
                role="option"
                aria-selected={i === mentionIndex}
                className={`${styles.mentionItem} ${i === mentionIndex ? styles.mentionItemActive : ''}`}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  insertMention(item);
                }}
              >
                <span className={styles.mentionBadge}>
                  {item.kind === 'folder'
                    ? 'DIR'
                    : item.kind === 'codebase'
                      ? 'CB'
                      : item.kind === 'problems'
                        ? 'ERR'
                        : item.kind === 'git'
                          ? 'GIT'
                          : item.kind === 'selection'
                            ? 'SEL'
                            : item.kind === 'image'
                              ? 'IMG'
                              : extBadge(item.name)}
                </span>
                <span className={styles.mentionPath}>{item.name}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.inputSurface}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={input}
            placeholder={
              voActive
                ? voAssignee === 'manager'
                  ? 'Task for Manager — they will assign a free developer…'
                  : `Task for ${VIRTUAL_OFFICE_ASSIGNEES.find((a) => a.id === voAssignee)?.name || 'teammate'}…`
                : chatMode === 'ask'
                ? 'Ask about the code…  @codebase @Problems @Git @Selection'
                : chatMode === 'agent'
                  ? 'Ask Agent…  @file · @codebase · drop images · Ctrl+K inline'
                  : 'Describe a goal…  @file or drop references'
            }
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items || []) as DataTransferItem[];
              for (const item of items) {
                if (!item.type.startsWith('image/')) {
                  continue;
                }
                e.preventDefault();
                const blob = item.getAsFile();
                if (!blob) {
                  continue;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  addAttachment({
                    path: `paste:${Date.now()}`,
                    name: `paste.${item.type.split('/')[1] || 'png'}`,
                    kind: 'image',
                    dataUrl: String(reader.result || ''),
                    mimeType: item.type,
                  });
                };
                reader.readAsDataURL(blob);
              }
            }}
            rows={1}
          />
          <div className={styles.inputFooter}>
            <span className={styles.composerHint}>
              <kbd>@</kbd> mention · <kbd>Enter</kbd> {busy ? 'queue' : 'send'} · <kbd>Shift</kbd>
              +<kbd>Enter</kbd> newline
            </span>
            <button
              type="button"
              className={`${styles.sendBtn} ${styles[`sendBtn_${sendMode}`] || ''}`}
              onClick={
                busy
                  ? () => chat.stop()
                  : canCompose
                    ? onSend
                    : undefined
              }
              disabled={sendMode === 'send' && !canCompose}
              title={
                sendMode === 'stop'
                  ? 'Stop generating'
                  : sendMode === 'done'
                    ? 'Reply complete'
                    : busy
                      ? 'Queue message'
                      : 'Send message'
              }
              aria-label={sendMode === 'stop' ? 'Stop generating' : 'Send message'}
            >
              {sendMode === 'stop' ? (
                <StopIcon size={14} />
              ) : sendMode === 'done' ? (
                <CheckIcon size={17} />
              ) : (
                <SendIcon size={17} />
              )}
            </button>
          </div>
        </div>
      </div>

      {liveTestOpen
        ? createPortal(
            <div
              className={styles.liveTestBackdrop}
              role="presentation"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setLiveTestOpen(false);
                }
              }}
            >
              <div
                className={styles.liveTestModal}
                role="dialog"
                aria-modal="true"
                aria-labelledby="olkil-live-test-title"
              >
                <div className={styles.liveTestModalHeader}>
                  <div className={styles.liveTestModalTitleBlock}>
                    <span className={styles.liveTestModalEyebrow}>Browser verify</span>
                    <h2 id="olkil-live-test-title" className={styles.liveTestModalTitle}>
                      Live Test
                    </h2>
                    <p className={styles.liveTestModalSub}>
                      Tell OLKIL what to exercise in a real headed browser — then it will start the
                      app, test, capture errors, fix, and retest.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={styles.liveTestModalClose}
                    aria-label="Close"
                    onClick={() => setLiveTestOpen(false)}
                  >
                    <span className={styles.liveTestModalCloseIcon} aria-hidden />
                  </button>
                </div>

                <label className={styles.liveTestLabel} htmlFor="olkil-live-test-prompt">
                  Custom prompt
                </label>
                <textarea
                  id="olkil-live-test-prompt"
                  ref={liveTestInputRef}
                  className={styles.liveTestTextarea}
                  value={liveTestPrompt}
                  onChange={(e) => setLiveTestPrompt(e.target.value)}
                  placeholder="e.g. Login with demo credentials and complete the main workflow…"
                  rows={4}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      runLiveTest();
                    }
                  }}
                />

                <div className={styles.liveTestSuggestionsLabel}>Suggestions</div>
                <div className={styles.liveTestSuggestions} role="list">
                  {LIVE_TEST_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="listitem"
                      className={`${styles.liveTestChip} ${
                        liveTestPrompt.trim() === s ? styles.liveTestChipActive : ''
                      }`}
                      onClick={() => setLiveTestPrompt(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <div className={styles.liveTestModalFooter}>
                  <button
                    type="button"
                    className={styles.liveTestCancel}
                    onClick={() => setLiveTestOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.liveTestStart}
                    disabled={!liveTestPrompt.trim() || busy || ollamaBlocked}
                    onClick={runLiveTest}
                  >
                    Start Live Test
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
