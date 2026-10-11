import { Autowired, Injectable } from '@opensumi/di';
import { Disposable, Emitter, Event } from '@opensumi/ide-core-common';
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  ChatPanelState,
  IOlkilChatUiService,
} from '../common';
import { IOlkilSettingsService } from '../../olkil-auth/common/settings';

const STORAGE_KEY = 'olkil.ai.panel';

interface PersistedLayout {
  width?: number;
  expanded?: boolean;
  pinned?: boolean;
  collapsed?: boolean;
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
 *
 * The panel is docked into the workbench's right edge. Every launch starts with
 * it collapsed into the edge tab so the editor opens at full width.
 */
@Injectable()
export class OlkilChatUiService extends Disposable implements IOlkilChatUiService {
  @Autowired(IOlkilSettingsService)
  private settings!: IOlkilSettingsService;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  state: ChatPanelState = 'closed';
  expanded = false;
  pinned = false;
  width = CHAT_PANEL_DEFAULT_WIDTH;

  private collapsed = false;
  private initialized = false;

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.readLayout();
    this.setState('minimized');
  }

  open() {
    this.setState('open');
  }

  /** There is no hidden state: closing docks the panel into the edge tab. */
  close() {
    this.setState('minimized');
  }

  toggle() {
    this.setState(this.state === 'open' ? 'minimized' : 'open');
  }

  minimize() {
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
    this.settings.patch({ pinAgentPanel: pinned });
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
    const collapsed = next !== 'open';
    if (collapsed !== this.collapsed) {
      this.collapsed = collapsed;
      this.writeLayout();
    }
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
      this.pinned = Boolean(saved.pinned);
      this.collapsed = Boolean(saved.collapsed);
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
        collapsed: this.collapsed,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Non-fatal: layout simply won't survive a restart.
    }
  }
}
