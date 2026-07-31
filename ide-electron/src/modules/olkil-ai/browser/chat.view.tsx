import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { ChatAttachment, FileChangeInfo, FileDiffLine, IOlkilChatService, OllamaDownloadUiState, UiChatMessage } from '../common';
import { MarkdownMessage } from './markdown';
import { CheckIcon, SendIcon, StopIcon } from './icons';
import styles from './chat.view.module.less';
import logoUrl from './olkil-logo.png';

/** How long the composer confirms a finished turn before offering Send again. */
const DONE_HINT_MS = 1800;
const INPUT_MAX_HEIGHT = 168;

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
}: {
  change: FileChangeInfo;
  onAccept: (id: string) => void;
  onRevert: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const title =
    change.kind === 'rename'
      ? `${change.displayName} → ${change.newDisplayName || ''}`
      : change.kind === 'delete'
        ? `Deleted ${change.displayName}`
        : change.displayName;
  const pending = change.status === 'pending';

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
          {change.kind === 'rename' && !change.additions && !change.deletions ? (
            <span className={styles.statRename}>renamed</span>
          ) : null}
          {change.kind === 'delete' ? <span className={styles.statDel}>deleted</span> : null}
          {change.editCount && change.editCount > 1 ? (
            <span className={styles.editCount}>{change.editCount} edits</span>
          ) : null}
        </span>
      </div>

      {change.preview?.length ? <DiffPreview lines={change.preview} /> : null}

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
  const [messages, setMessages] = useState<UiChatMessage[]>(chat.messages);
  const [status, setStatus] = useState(chat.status);
  const [busy, setBusy] = useState(chat.busy);
  const [modelId, setModelId] = useState(chat.modelId);
  const [models, setModels] = useState(chat.models);
  const [chatMode, setChatMode] = useState(chat.chatMode);
  const [ollamaDownload, setOllamaDownload] = useState<OllamaDownloadUiState>(chat.ollamaDownload);
  const [pendingCount, setPendingCount] = useState(chat.pendingChanges.length);
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

  const sync = useCallback(() => {
    setMessages([...chat.messages]);
    setStatus(chat.status);
    setBusy(chat.busy);
    setModelId(chat.modelId);
    setModels([...chat.models]);
    setChatMode(chat.chatMode);
    setOllamaDownload({ ...chat.ollamaDownload });
    setPendingCount(chat.pendingChanges.length);
  }, [chat]);

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

  // Catch up in one pass when the panel is brought back.
  useEffect(() => {
    if (!dormant && staleRef.current) {
      staleRef.current = false;
      sync();
    }
  }, [dormant, sync]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || dormant) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, status, dormant]);

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
    if ((!text && attachments.length === 0) || busy) {
      return;
    }
    setInput('');
    const atts = [...attachments];
    setAttachments([]);
    setMentionOpen(false);
    await chat.send(text, atts);
    inputRef.current?.focus();
  }, [attachments, busy, chat, input]);

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
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      const p = (f as any).path as string;
      if (!p) {
        continue;
      }
      // Electron File objects expose .path
      const name = p.replace(/\\/g, '/').split('/').pop() || p;
      // Heuristic: no extension or trailing slash-ish → folder (Electron folders may appear as files)
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

  const rows = useMemo(() => messages, [messages]);
  const ollamaBlocked =
    ollamaDownload.phase === 'needs_download' ||
    ollamaDownload.phase === 'starting' ||
    ollamaDownload.phase === 'downloading' ||
    ollamaDownload.phase === 'paused' ||
    ollamaDownload.phase === 'error';
  const canSend = !busy && !ollamaBlocked && (Boolean(input.trim()) || attachments.length > 0);
  const sendMode = busy ? 'stop' : turnDone && !canSend ? 'done' : 'send';

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
              title="Autonomous: explores & edits files itself"
            >
              Agent
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={chatMode === 'plan'}
              className={`${styles.modeBtn} ${chatMode === 'plan' ? styles.modeBtnActive : ''}`}
              disabled={busy}
              onClick={() => chat.setChatMode('plan')}
              title="Discuss first: outlines a plan before big edits"
            >
              Plan
            </button>
          </div>
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

      <div className={styles.list} ref={listRef}>
        {rows.map((m) => {
          if (m.role === 'file_change' && m.fileChange) {
            return (
              <div key={m.id} className={styles.rowLeft}>
                <FileChangeCard
                  change={m.fileChange}
                  onAccept={(id) => chat.acceptChange(id)}
                  onRevert={(id) => chat.revertChange(id)}
                  onOpen={(id) => chat.openChangeFile(id)}
                />
              </div>
            );
          }

          const isUser = m.role === 'user';
          const isSystem = m.role === 'system' || m.role === 'status';
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
                } ${m.pending ? styles.bubblePending : ''}`}
              >
                {!isUser && !isSystem ? (
                  <div className={styles.roleRow}>
                    <img className={styles.roleAvatar} src={logoUrl} alt="" width={14} height={14} draggable={false} />
                    <span className={styles.role}>{chatMode === 'plan' ? 'Plan' : 'Agent'}</span>
                  </div>
                ) : null}
                {isUser || isSystem ? (
                  <div className={styles.content}>{m.content || (m.pending ? '…' : '')}</div>
                ) : (
                  <MarkdownMessage
                    className={styles.contentMd}
                    text={m.content || (m.pending ? '…' : '')}
                  />
                )}
              </div>
            </div>
          );
        })}
        {status ? <div className={styles.status}>{status}</div> : null}
      </div>

      <div
        className={`${styles.composer} ${dragOver ? styles.composerDrop : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
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
                <span className={styles.mentionBadge}>{item.kind === 'folder' ? 'DIR' : extBadge(item.name)}</span>
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
              chatMode === 'agent'
                ? 'Ask Agent…  @file for context, or drop files here'
                : 'Describe a goal…  @file or drop references'
            }
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            rows={1}
          />
          <div className={styles.inputFooter}>
            <span className={styles.composerHint}>
              <kbd>@</kbd> mention · <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
            </span>
            <button
              type="button"
              className={`${styles.sendBtn} ${styles[`sendBtn_${sendMode}`] || ''}`}
              onClick={busy ? () => chat.stop() : onSend}
              disabled={sendMode === 'send' && !canSend}
              title={
                sendMode === 'stop'
                  ? 'Stop generating'
                  : sendMode === 'done'
                    ? 'Reply complete'
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
    </div>
  );
};
