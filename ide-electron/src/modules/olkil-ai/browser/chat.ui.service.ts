import { Autowired, Injectable } from '@opensumi/di';
import { Disposable, Emitter, Event } from '@opensumi/ide-core-common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  ChatPanelState,
  IOlkilChatService,
  IOlkilChatUiService,
} from '../common';

const STORAGE_KEY = 'olkil.ai.panel';

interface PersistedLayout {
  width?: number;
  expanded?: boolean;
  pinned?: boolean;
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return CHAT_PANEL_DEFAULT_WIDTH;
  }
  return Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, Math.round(width)));
}

/**
 * Owns where/how big the agent panel is. Split from `OlkilChatService` so that
 * chrome changes (open, minimize, resize) never re-render the message list, and
 * so a streaming conversation never re-lays out the panel.
 */
@Injectable()
export class OlkilChatUiService extends Disposable implements IOlkilChatUiService {
  @Autowired(WorkbenchEditorService)
  private editorService!: WorkbenchEditorService;

  @Autowired(IOlkilChatService)
  private chat!: IOlkilChatService;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  /** Always starts closed: the first paint stays cheap. */
  state: ChatPanelState = 'closed';
  expanded = false;
  pinned = false;
  width = CHAT_PANEL_DEFAULT_WIDTH;

  private initialized = false;

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.readLayout();
    this.addDispose(
      this.editorService.onActiveResourceChange(() => {
        // Reading code wins over chatting: fold the panel into its pill so the
        // editor is never covered. Pinning (or a running turn) opts out.
        if (this.state === 'open' && !this.pinned && !this.chat.busy) {
          this.minimize();
        }
      }),
    );
  }

  open() {
    this.setState('open');
  }

  close() {
    this.setState('closed');
  }

  toggle() {
    this.setState(this.state === 'open' ? 'closed' : 'open');
  }

  minimize() {
    if (this.state === 'closed') {
      return;
    }
    this.setState('minimized');
  }

  restore() {
    this.setState('open');
  }

  setExpanded(expanded: boolean) {
    if (this.expanded === expanded) {
      return;
    }
    this.expanded = expanded;
    this.writeLayout();
    this.fire();
  }

  setPinned(pinned: boolean) {
    if (this.pinned === pinned) {
      return;
    }
    this.pinned = pinned;
    this.writeLayout();
    this.fire();
  }

  setWidth(width: number) {
    const next = clampWidth(width);
    if (next === this.width) {
      return;
    }
    this.width = next;
    this.writeLayout();
    this.fire();
  }

  private setState(next: ChatPanelState) {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.fire();
  }

  private fire() {
    this._onDidChange.fire();
  }

  private readLayout() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const saved = JSON.parse(raw) as PersistedLayout;
      this.width = clampWidth(saved.width ?? CHAT_PANEL_DEFAULT_WIDTH);
      this.expanded = Boolean(saved.expanded);
      this.pinned = Boolean(saved.pinned);
    } catch {
      // Corrupt/blocked storage just means defaults.
    }
  }

  private writeLayout() {
    try {
      const payload: PersistedLayout = {
        width: this.width,
        expanded: this.expanded,
        pinned: this.pinned,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Non-fatal: layout simply won't survive a restart.
    }
  }
}
