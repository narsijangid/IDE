import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { FileChangeInfo, FileDiffLine, IOlkilChatService, UiChatMessage } from '../common';
import { MarkdownMessage } from './markdown';
import styles from './chat.view.module.less';
import logoUrl from './olkil-logo.png';

function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <span className={styles.brandMark}>
      <img src={logoUrl} alt="" width={size} height={size} draggable={false} />
      <span className={styles.brandText}>OLKIL</span>
    </span>
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
}: {
  change: FileChangeInfo;
  onAccept: (id: string) => void;
  onRevert: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const title =
    change.kind === 'rename'
      ? `${change.displayName} → ${change.newDisplayName || ''}`
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

export const OlkilAiChatView = () => {
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  const [messages, setMessages] = useState<UiChatMessage[]>(chat.messages);
  const [status, setStatus] = useState(chat.status);
  const [busy, setBusy] = useState(chat.busy);
  const [modelId, setModelId] = useState(chat.modelId);
  const [models, setModels] = useState(chat.models);
  const [chatMode, setChatMode] = useState(chat.chatMode);
  const [pendingCount, setPendingCount] = useState(chat.pendingChanges.length);
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chat.init();
    const d = chat.onDidChange(() => {
      startTransition(() => {
        setMessages([...chat.messages]);
        setStatus(chat.status);
        setBusy(chat.busy);
        setModelId(chat.modelId);
        setModels([...chat.models]);
        setChatMode(chat.chatMode);
        setPendingCount(chat.pendingChanges.length);
      });
    });
    return () => d.dispose();
  }, [chat]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setInput('');
    await chat.send(text);
    inputRef.current?.focus();
  }, [busy, chat, input]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    chat.setModel(e.target.value);
  };

  const rows = useMemo(() => messages, [messages]);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.title}>
            <BrandMark size={20} />
          </div>
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
          <select
            className={styles.modelSelect}
            value={modelId}
            onChange={onModelChange}
            disabled={busy}
            title="Select AI model"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.actions}>
          {busy ? (
            <button type="button" className={styles.ghostBtn} onClick={() => chat.stop()}>
              Stop
            </button>
          ) : null}
          <button type="button" className={styles.ghostBtn} onClick={() => chat.clear()} disabled={busy}>
            Clear
          </button>
        </div>
      </header>

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

      <div className={styles.composer}>
        <textarea
          ref={inputRef}
          className={styles.input}
          value={input}
          placeholder={
            chatMode === 'agent'
              ? 'Tell Agent what to do — it will find & edit files…'
              : 'Describe a goal — Plan will outline steps first…'
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          disabled={busy}
        />
        <button type="button" className={styles.sendBtn} onClick={onSend} disabled={busy || !input.trim()}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
};
