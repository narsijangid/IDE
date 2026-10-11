import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  ChatPanelState,
  IOlkilChatService,
  IOlkilChatUiService,
} from '../common';
import { ExtensionChatHost } from './extension-chat-host';
import { useLiveStatusLabel, useWorkspaceRoot } from './live-status-rotator';
import { CollapseIcon, ExpandIcon, HistoryIcon, MinimizeIcon, NewChatIcon } from './icons';
import styles from './overlay.module.less';
import logoUrl from '../../../browser/assets/olkil-icon.png';

/** Matches the panel transition duration in overlay.module.less. */
const EXIT_MS = 320;
/** Space the editor keeps beside the docked panel. */
const MIN_EDITOR_SPACE = 420;
/** Below this window width the panel floats over the editor instead of docking. */
const DOCK_MIN_VIEWPORT = 900;
/** Workbench reflows during a drag are throttled; the panel itself follows every frame. */
const DRAG_REFLOW_MS = 90;

function panelFit(width: number, viewport: number): { px: number; max: number; docked: boolean } {
  const docked = viewport >= DOCK_MIN_VIEWPORT;
  const max = docked
    ? Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(CHAT_PANEL_MAX_WIDTH, viewport - MIN_EDITOR_SPACE))
    : Math.max(280, viewport - 40);
  const min = Math.min(CHAT_PANEL_MIN_WIDTH, max);
  return { px: Math.round(Math.min(max, Math.max(min, width))), max, docked };
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setWidth(window.innerWidth);
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.cancelAnimationFrame(frame);
    };
  }, []);
  return width;
}

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

/** The workbench row holding the sidebar and editor (between title bar and status bar). */
function workbenchRow(): HTMLElement | null {
  return document.getElementById('main-horizontal')?.parentElement ?? null;
}

/** Shrinks the workbench row so the docked panel sits beside the editor, not over it. */
function reserveColumn(px: number) {
  const row = workbenchRow();
  if (row) {
    row.style.marginRight = px > 0 ? `${px}px` : '';
  }
}

export const OlkilAiOverlay = () => {
  const ui = useInjectable<IOlkilChatUiService>(IOlkilChatUiService);
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);

  const [state, setState] = useState<ChatPanelState>(ui.state);
  const [expanded, setExpanded] = useState(ui.expanded);
  const [savedWidth, setSavedWidth] = useState(ui.width);
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
      setSavedWidth(ui.width);
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

  const viewport = useViewportWidth();
  const fit = panelFit(savedWidth, viewport);

  const setPanelWidth = useCallback((px: number) => {
    panelRef.current?.style.setProperty('--olkil-panel-width', `${px}px`);
  }, []);

  useEffect(() => {
    if (mounted) {
      setPanelWidth(fit.px);
    }
  }, [setPanelWidth, mounted, fit.px]);

  useEffect(() => {
    reserveColumn(open && fit.docked ? fit.px : 0);
  }, [open, fit.docked, fit.px]);

  useEffect(() => () => reserveColumn(0), []);

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const panel = panelRef.current;
      if (!panel || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const grip = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const { max: maxWidth, docked } = panelFit(startWidth, window.innerWidth);
      const minWidth = Math.min(CHAT_PANEL_MIN_WIDTH, maxWidth);
      let width = startWidth;
      let frame = 0;
      let lastReflow = 0;

      panel.classList.add(styles.panelResizing);
      document.body.classList.add(styles.bodyResizing);

      const onMove = (moveEvent: PointerEvent) => {
        width = Math.round(Math.min(maxWidth, Math.max(minWidth, startWidth + (startX - moveEvent.clientX))));
        if (frame) {
          return;
        }
        frame = window.requestAnimationFrame((now) => {
          frame = 0;
          setPanelWidth(width);
          // Reflowing the editor is the expensive part, so it trails the pointer slightly.
          if (docked && now - lastReflow >= DRAG_REFLOW_MS) {
            lastReflow = now;
            reserveColumn(width);
          }
        });
      };

      let done = false;
      const onUp = () => {
        if (done) {
          return;
        }
        done = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('blur', onUp);
        grip.removeEventListener('lostpointercapture', onUp);
        if (grip.hasPointerCapture?.(pointerId)) {
          grip.releasePointerCapture(pointerId);
        }
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        panel.classList.remove(styles.panelResizing);
        document.body.classList.remove(styles.bodyResizing);
        setPanelWidth(width);
        if (docked) {
          reserveColumn(width);
        }
        ui.setWidth(width);
      };

      // Capture keeps move/up events flowing when the cursor crosses the chat iframe.
      try {
        grip.setPointerCapture(pointerId);
      } catch {
        // Pointer already released; the window listeners still end the drag.
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('blur', onUp);
      grip.addEventListener('lostpointercapture', onUp);
    },
    [setPanelWidth, ui],
  );

  const onResizeReset = useCallback(() => {
    ui.setWidth(CHAT_PANEL_DEFAULT_WIDTH);
    const { px, docked } = panelFit(CHAT_PANEL_DEFAULT_WIDTH, window.innerWidth);
    setPanelWidth(px);
    if (docked) {
      reserveColumn(px);
    }
  }, [setPanelWidth, ui]);

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
  const chromeBusy = busy;
  const busyStatusLabel = useLiveStatusLabel({
    active: chromeBusy,
    status: liveStatus,
    workspaceRoot,
  });

  useEffect(() => {
    if (!chromeBusy || !busyStatusLabel || busyStatusLabel === liveLabelPrevRef.current) {
      liveLabelPrevRef.current = busyStatusLabel;
      return;
    }
    liveLabelPrevRef.current = busyStatusLabel;
    setLiveLabelAnimating(true);
    const t = window.setTimeout(() => setLiveLabelAnimating(false), 480);
    return () => window.clearTimeout(t);
  }, [chromeBusy, busyStatusLabel]);

  const statusLabel = chromeBusy
    ? busyStatusLabel || 'Planning next move'
    : pendingCount > 0
      ? `${pendingCount} to review`
      : 'Ready';

  const liveTagClass = cx(
    styles.liveTag,
    chromeBusy && styles.liveTagBusy,
    chromeBusy && liveLabelAnimating && styles.liveTagSwap,
  );

  return (
    <div className={styles.host} ref={hostRef}>
      <button
        type="button"
        className={cx(styles.edgeTab, open && styles.edgeTabHidden)}
        onClick={() => ui.restore()}
        title={`OLKIL Agent · ${statusLabel} — Ctrl+L`}
        aria-label="Open OLKIL Agent"
        tabIndex={open ? -1 : 0}
      >
        <img src={logoUrl} alt="" width={20} height={20} draggable={false} />
        {busy || pendingCount > 0 ? (
          <span className={cx(styles.edgeDot, chromeBusy && styles.edgeDotBusy)} />
        ) : null}
      </button>

      {mounted ? (
        <section
          ref={panelRef as React.RefObject<HTMLElement>}
          className={cx(
            styles.panel,
            !fit.docked && styles.panelFloating,
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
            onDoubleClick={onResizeReset}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize agent panel"
            title="Drag to resize · double-click to reset"
          />

          <header className={styles.titleBar}>
            <span className={styles.brand}>
              <img src={logoUrl} alt="" width={16} height={16} draggable={false} />
              <span className={styles.brandName}>OLKIL</span>
              <span className={styles.brandSub}>Agent</span>
            </span>

            <span key={chromeBusy ? statusLabel : 'idle'} className={liveTagClass}>
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
                title="Minimize to the side — Ctrl+L"
                aria-label="Minimize agent panel"
              >
                <MinimizeIcon size={15} />
              </button>
            </div>
          </header>

          <div className={styles.panelBody}>
            <ExtensionChatHost />
          </div>
        </section>
      ) : null}
    </div>
  );
};
