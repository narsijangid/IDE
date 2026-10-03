import { BrowserWindow, desktopCapturer, ipcMain, type WebContents } from 'electron';

type PointerMsg = { t: 'p'; k: 'down' | 'move' | 'up'; x: number; y: number; b?: number; clicks?: number };
type WheelMsg = { t: 'w'; x: number; y: number; dx?: number; dy?: number };
type KeyMsg = { t: 'key'; k: 'down' | 'up'; key?: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
type InputMsg = PointerMsg | WheelMsg | KeyMsg;

const armed = new Set<number>();

/** Live window picture and input stay inside this OLKIL window. */
export function registerScreenControl(): void {
  ipcMain.handle('olkil:screen-source', async (event) => sourceId(event.sender));

  ipcMain.on('olkil:screen-arm', (event, on: boolean) => {
    const id = event.sender.id;
    if (on) armed.add(id);
    else armed.delete(id);
  });

  ipcMain.on('olkil:screen-input', (event, raw: unknown) => {
    if (!armed.has(event.sender.id)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    applyInput(win, raw);
  });
}

async function sourceId(sender: WebContents): Promise<string> {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return '';
  try {
    const id = win.getMediaSourceId();
    if (id) return id;
  } catch {
    /* fall through to the window list */
  }
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const title = win.getTitle();
  const hit = sources.find((source) => source.name === title) || sources.find((source) => /olkil/i.test(source.name));
  return hit?.id || '';
}

function applyInput(win: BrowserWindow, raw: unknown): void {
  const msg = raw as InputMsg;
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
  if (msg.t === 'key' && msg.k === 'down' && win.isMinimized()) win.restore();
  if (msg.t === 'p' && msg.k === 'down') {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  const bounds = win.getBounds();
  const content = win.getContentBounds();
  const x = Math.round(num(msg, 'x') * bounds.width - (content.x - bounds.x));
  const y = Math.round(num(msg, 'y') * bounds.height - (content.y - bounds.y));
  const wc = win.webContents;
  if (msg.t === 'p') {
    if (x < 0 || y < 0 || x > content.width || y > content.height) return;
    const button = msg.b === 2 ? 'right' : msg.b === 1 ? 'middle' : 'left';
    const type = msg.k === 'down' ? 'mouseDown' : msg.k === 'up' ? 'mouseUp' : 'mouseMove';
    wc.sendInputEvent({
      type,
      x,
      y,
      button,
      clickCount: type === 'mouseMove' ? 0 : Math.max(1, Number(msg.clicks) || 1),
    });
    return;
  }
  if (msg.t === 'w') {
    if (x < 0 || y < 0) return;
    wc.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: Math.round(Number(msg.dx) || 0),
      deltaY: Math.round(Number(msg.dy) || 0),
    });
    return;
  }
  if (msg.t === 'key') {
    const keyCode = domKey(String(msg.key || ''), String(msg.code || ''));
    if (!keyCode) return;
    const modifiers = mods(msg);
    wc.sendInputEvent({ type: msg.k === 'up' ? 'keyUp' : 'keyDown', keyCode, modifiers });
    if (msg.k !== 'up' && String(msg.key || '').length === 1 && !msg.ctrl && !msg.meta) {
      wc.sendInputEvent({ type: 'char', keyCode: String(msg.key) });
    }
  }
}

function num(msg: object, key: string): number {
  const value = (msg as Record<string, unknown>)[key];
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function mods(msg: KeyMsg): Array<'control' | 'shift' | 'alt' | 'meta'> {
  const list: Array<'control' | 'shift' | 'alt' | 'meta'> = [];
  if (msg.ctrl) list.push('control');
  if (msg.shift) list.push('shift');
  if (msg.alt) list.push('alt');
  if (msg.meta) list.push('meta');
  return list;
}

function domKey(key: string, code: string): string {
  const named: Record<string, string> = {
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ' ': 'Space',
  };
  if (named[key]) return named[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  if (key.length === 1) return key;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  return '';
}
