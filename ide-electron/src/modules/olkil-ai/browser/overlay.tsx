import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import {
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  ChatPanelState,
  IOlkilChatService,
  IOlkilChatUiService,
} from '../common';
import { OlkilAiChatView } from './chat.view';
import { useLiveStatusLabel, useWorkspaceRoot } from './live-status-rotator';
import {
  AiSparkIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  HistoryIcon,
  MinimizeIcon,
  NewChatIcon,
  PinIcon,
} from './icons';
import styles from './overlay.module.less';
import logoUrl from './olkil-logo.png';

/** Matches the panel transition duration in overlay.module.less. */
const EXIT_MS = 320;

function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ');
}

function formatHistoryAge(updatedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - updatedAt) / 60000));
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hrs = Math.round(mins / 60);
  if (hrs < 48) {
    return `${hrs}h ago`;
  }
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Keeps the overlay clear of the title bar and status bar by mirroring their
 * live geometry into CSS variables. A ResizeObserver is used instead of a
 * resize listener so a single layout read covers window resizes, panel drags
 * and status-bar height changes.
 */
function useWorkbenchInset(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const topBar = document.getElementById('top');
    const statusBar = document.getElementById('statusBar');

    const apply = () => {
      const host = ref.current;
      if (!host) {
        return;
      }
      const top = topBar ? Math.round(topBar.getBoundingClientRect().bottom) : 0;
      const statusTop = statusBar ? statusBar.getBoundingClientRect().top : window.innerHeight - 24;
      const bottom = Math.max(0, Math.round(window.innerHeight - statusTop));
      host.style.setProperty('--olkil-inset-top', `${Math.max(0, top)}px`);
      host.style.setProperty('--olkil-inset-bottom', `${bottom}px`);
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(document.body);
    if (topBar) {
      observer.observe(topBar);
    }
    if (statusBar) {
      observer.observe(statusBar);
    }
    return () => observer.disconnect();
  }, [ref]);
}

export const OlkilAiOverlay = () => {
  const ui = useInjectable<IOlkilChatUiService>(IOlkilChatUiService);
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);

  const [state, setState] = useState<ChatPanelState>(ui.state);
  const [expanded, setExpanded] = useState(ui.expanded);
  const [pinned, setPinned] = useState(ui.pinned);
  const [busy, setBusy] = useState(chat.busy);
  const [liveStatus, setLiveStatus] = useState(chat.status);
  const [pendingCount, setPendingCount] = useState(chat.pendingChanges.length);
  const [history, setHistory] = useState(chat.chatHistory || []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const liveLabelPrevRef = useRef('');
  const [liveLabelAnimating, setLiveLabelAnimating] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useWorkbenchInset(hostRef);

  useEffect(() => {
    const d = ui.onDidChange(() => {
      setState(ui.state);
      setExpanded(ui.expanded);
      setPinned(ui.pinned);
    });
    return () => d.dispose();
  }, [ui]);

  // Only chrome-relevant chat state is mirrored here; message updates stay
  // inside the chat view so a streaming reply never re-renders the shell.
  useEffect(() => {
    const d = chat.onDidChange(() => {
      setBusy(chat.busy);
      setLiveStatus(chat.status);
      setPendingCount(chat.pendingChanges.length);
      setHistory(chat.chatHistory || []);
    });
    return () => d.dispose();
  }, [chat]);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [historyOpen]);

  const open = state === 'open';

  // Mounted stays true across minimize so scroll position and composer draft
  // survive; it only drops after the close animation has finished.
  const [mounted, setMounted] = useState(state !== 'closed');
  const [offscreen, setOffscreen] = useState(state !== 'open');

  useEffect(() => {
    if (state !== 'closed') {
      setMounted(true);
    }
    if (open) {
      setOffscreen(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setOffscreen(true);
      if (state === 'closed') {
        setMounted(false);
      }
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [state, open]);

  const applyWidth = useCallback((px: number) => {
    panelRef.current?.style.setProperty('--olkil-panel-width', `${px}px`);
  }, []);

  useEffect(() => {
    if (mounted) {
      applyWidth(ui.width);
    }
  }, [applyWidth, mounted, ui.width]);

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const panel = panelRef.current;
      if (!panel || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const maxWidth = Math.min(CHAT_PANEL_MAX_WIDTH, window.innerWidth - 160);
      let width = startWidth;
      let frame = 0;

      panel.classList.add(styles.panelResizing);

      const onMove = (moveEvent: PointerEvent) => {
        width = Math.min(maxWidth, Math.max(CHAT_PANEL_MIN_WIDTH, startWidth + (startX - moveEvent.clientX)));
        if (frame) {
          return;
        }
        // One style write per frame keeps the drag at display refresh rate.
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          applyWidth(width);
        });
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        panel.classList.remove(styles.panelResizing);
        ui.setWidth(width);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [applyWidth, ui],
  );

  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation();
        ui.minimize();
      }
    },
    [ui],
  );

  const workspaceRoot = useWorkspaceRoot();
  const busyStatusLabel = useLiveStatusLabel({
    active: busy,
    status: liveStatus,
    workspaceRoot,
  });

  useEffect(() => {
    if (!busy || !busyStatusLabel || busyStatusLabel === liveLabelPrevRef.current) {
      liveLabelPrevRef.current = busyStatusLabel;
      return;
    }
    liveLabelPrevRef.current = busyStatusLabel;
    setLiveLabelAnimating(true);
    const t = window.setTimeout(() => setLiveLabelAnimating(false), 480);
    return () => window.clearTimeout(t);
  }, [busy, busyStatusLabel]);

  const statusLabel = busy
    ? busyStatusLabel || 'Thinking'
    : pendingCount > 0
      ? `${pendingCount} to review`
      : 'Ready';

  const liveTagClass = cx(
    styles.liveTag,
    busy && styles.liveTagBusy,
    busy && liveLabelAnimating && styles.liveTagSwap,
  );

  return (
    <div className={styles.host} ref={hostRef}>
      <button
        type="button"
        className={cx(styles.chip, styles.launcher, state !== 'closed' && styles.chipHidden)}
        onClick={() => ui.open()}
        title="OLKIL Agent — Ctrl+L"
        aria-label="Open OLKIL Agent"
        tabIndex={state === 'closed' ? 0 : -1}
      >
        <AiSparkIcon size={18} className={styles.chipGlyph} />
        {busy || pendingCount > 0 ? <span className={cx(styles.chipDot, busy && styles.chipDotBusy)} /> : null}
      </button>

      <button
        type="button"
        className={cx(styles.chip, styles.pill, state !== 'minimized' && styles.chipHidden)}
        onClick={() => ui.restore()}
        title="Restore OLKIL Agent — Ctrl+L"
        aria-label="Restore OLKIL Agent"
        tabIndex={state === 'minimized' ? 0 : -1}
      >
        <AiSparkIcon size={15} className={styles.chipGlyph} />
        <span className={styles.pillLabel}>{statusLabel}</span>
        <span className={cx(styles.chipDot, styles.pillDot, busy && styles.chipDotBusy)} />
      </button>

      {mounted ? (
        <section
          ref={panelRef as React.RefObject<HTMLElement>}
          className={cx(
            styles.panel,
            expanded && styles.panelExpanded,
            !open && styles.panelHidden,
            !open && offscreen && styles.panelOffscreen,
          )}
          onKeyDown={onPanelKeyDown}
          aria-label="OLKIL Agent"
          aria-hidden={!open}
        >
          <div
            className={styles.resizeGrip}
            onPointerDown={onResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize agent panel"
          />

          <header className={styles.titleBar}>
            <span className={styles.brand}>
              <img src={logoUrl} alt="" width={16} height={16} draggable={false} />
              <span className={styles.brandName}>OLKIL</span>
              <span className={styles.brandSub}>Agent</span>
            </span>

            <span key={busy ? statusLabel : 'idle'} className={liveTagClass}>
              {statusLabel}
            </span>

            <div className={styles.titleActions}>
              <div className={styles.historyWrap} ref={historyRef}>
                <button
                  type="button"
                  className={cx(styles.iconBtn, historyOpen && styles.iconBtnOn)}
                  onClick={() => setHistoryOpen((v) => !v)}
                  disabled={busy}
                  title={
                    history.length
                      ? `Chat history (${history.length}/3, expires in 48h)`
                      : 'Chat history — sign in to sync (max 3, 48h)'
                  }
                  aria-label="Chat history"
                  aria-expanded={historyOpen}
                >
                  <HistoryIcon size={15} />
                </button>
                {historyOpen ? (
                  <div className={styles.historyMenu} role="menu">
                    <div className={styles.historyHead}>Recent chats · max 3 · 48h</div>
                    {history.length === 0 ? (
                      <div className={styles.historyEmpty}>
                        No saved chats yet. Sign in and chat — only the latest 3 are kept.
                      </div>
                    ) : (
                      history.map((h) => (
                        <button
                          key={h.id}
                          type="button"
                          role="menuitem"
                          className={styles.historyItem}
                          disabled={busy}
                          onClick={() => {
                            setHistoryOpen(false);
                            void chat.loadChatHistory(h.id);
                          }}
                        >
                          <span className={styles.historyTitle}>{h.title}</span>
                          <span className={styles.historyMeta}>
                            {formatHistoryAge(h.updatedAt)} · {h.messageCount} msgs
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => chat.newChat()}
                disabled={busy}
                title="New chat"
                aria-label="New chat"
              >
                <NewChatIcon size={15} />
              </button>
              <button
                type="button"
                className={cx(styles.iconBtn, pinned && styles.iconBtnOn)}
                onClick={() => ui.setPinned(!pinned)}
                title={pinned ? 'Unpin — hide when a file opens' : 'Pin — stay open when a file opens'}
                aria-label="Pin agent panel"
                aria-pressed={pinned}
              >
                <PinIcon size={15} />
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => ui.setExpanded(!expanded)}
                title={expanded ? 'Restore panel width' : 'Full screen'}
                aria-label={expanded ? 'Restore panel width' : 'Full screen'}
              >
                {expanded ? <CollapseIcon size={15} /> : <ExpandIcon size={15} />}
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => ui.minimize()}
                title="Minimize"
                aria-label="Minimize agent panel"
              >
                <MinimizeIcon size={15} />
              </button>
              <button
                type="button"
                className={cx(styles.iconBtn, styles.iconBtnDanger)}
                onClick={() => ui.close()}
                title="Close"
                aria-label="Close agent panel"
              >
                <CloseIcon size={15} />
              </button>
            </div>
          </header>

          <div className={styles.panelBody}>
            <OlkilAiChatView dormant={!open} />
          </div>
        </section>
      ) : null}
    </div>
  );
};
