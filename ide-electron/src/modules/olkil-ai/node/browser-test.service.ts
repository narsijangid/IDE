import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';
import {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserDevToolsRequest,
  LiveTestRequest,
  LiveTestResult,
} from '../common';
import { CommandRunner, extractLocalUrls } from './command-runner';

type PlaywrightModule = typeof import('playwright');
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;
type CDPSession = import('playwright').CDPSession;

interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

interface NetworkFailure {
  url: string;
  method: string;
  status?: number;
  error?: string;
  timestamp: number;
}

interface NetworkRequestEntry {
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  error?: string;
  timestamp: number;
}

type DevToolsPanel = 'console' | 'network' | 'elements' | 'sources' | 'application';

const OLKIL_PINK_RGB = '254,1,154';
/** Narrow right-dock width — “thoda sa”, not half the window. */
const DEVTOOLS_DOCK_PX = 320;
const WINDOW_W = 1180;
const WINDOW_H = 780;
const VIEWPORT_W = 1080;
const VIEWPORT_H = 720;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  if (!s) {
    return '';
  }
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isApiLike(resourceType: string, url: string): boolean {
  const t = (resourceType || '').toLowerCase();
  if (t === 'xhr' || t === 'fetch') {
    return true;
  }
  // Common API paths even if classified as document/other
  return /\/(api|graphql|rest|v\d+)\b/i.test(url);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: string }> {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: 1200 }, (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      if (status > 0 && status < 500) {
        return { ok: true, status };
      }
      lastError = `HTTP ${status}`;
    } catch (e: any) {
      lastError = e?.message || String(e);
    }
    await sleep(280);
  }
  return { ok: false, error: lastError || 'Timed out waiting for URL' };
}

type UploadKind = 'image' | 'pdf' | 'document' | 'spreadsheet' | 'any';

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.heic',
  '.tif',
  '.tiff',
]);
const PDF_EXTS = new Set(['.pdf']);
const DOC_EXTS = new Set(['.doc', '.docx', '.txt', '.rtf', '.odt', '.md']);
const SHEET_EXTS = new Set(['.xls', '.xlsx', '.csv', '.ods']);

function userFileDirs(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Downloads'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'Documents'),
  ];
  return [...new Set(candidates.filter((d) => {
    try {
      return fs.existsSync(d) && fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  }))];
}

function inferUploadKind(accept?: string | null, hint?: string | null): UploadKind {
  const blob = `${accept || ''} ${hint || ''}`.toLowerCase();
  if (/image\/|\.png|\.jpe?g|\.gif|\.webp|\.svg|\.bmp|photo|avatar|logo|picture|img/i.test(blob)) {
    return 'image';
  }
  if (/application\/pdf|\.pdf|\bpdf\b/i.test(blob)) {
    return 'pdf';
  }
  if (/spreadsheet|excel|\.xlsx?|\.csv|sheet/i.test(blob)) {
    return 'spreadsheet';
  }
  if (/msword|officedocument|\.docx?|\.txt|\.rtf|document/i.test(blob)) {
    return 'document';
  }
  return 'any';
}

function extMatchesKind(ext: string, kind: UploadKind): boolean {
  const e = ext.toLowerCase();
  if (kind === 'image') return IMAGE_EXTS.has(e);
  if (kind === 'pdf') return PDF_EXTS.has(e);
  if (kind === 'document') return DOC_EXTS.has(e) || PDF_EXTS.has(e);
  if (kind === 'spreadsheet') return SHEET_EXTS.has(e);
  return (
    IMAGE_EXTS.has(e) ||
    PDF_EXTS.has(e) ||
    DOC_EXTS.has(e) ||
    SHEET_EXTS.has(e)
  );
}

/** Newest matching file under Downloads/Desktop (mtime). */
function findLatestUploadFile(kind: UploadKind, accept?: string | null): string | null {
  const acceptExts = (accept || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.startsWith('.') && p.length <= 8)
    .map((p) => (p.includes('/') ? '' : p))
    .filter(Boolean);

  let best: { path: string; mtime: number } | null = null;
  let bestAny: { path: string; mtime: number } | null = null;

  for (const dir of userFileDirs()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'desktop.ini') continue;
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      const ext = path.extname(name).toLowerCase();
      if (!ext) continue;
      const mtime = st.mtimeMs;
      if (!bestAny || mtime > bestAny.mtime) {
        bestAny = { path: full, mtime };
      }
      const acceptHit = acceptExts.length ? acceptExts.includes(ext) : false;
      const kindHit = extMatchesKind(ext, kind);
      if (acceptHit || kindHit) {
        if (!best || mtime > best.mtime) {
          best = { path: full, mtime };
        }
      }
    }
  }
  return best?.path || (kind === 'any' ? bestAny?.path || null : null) || bestAny?.path || null;
}

export class BrowserTestService {
  private pw: PlaywrightModule | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleLog: ConsoleEntry[] = [];
  private networkFailures: NetworkFailure[] = [];
  private networkRequests: NetworkRequestEntry[] = [];
  private lastUrl = '';
  private screenshotDir = path.join(os.tmpdir(), 'olkil-live-test');
  private userDataDir = path.join(os.tmpdir(), 'olkil-live-browser-profile');
  private devtoolsOpen = false;
  private activePanel: DevToolsPanel = 'console';
  private cdp: CDPSession | null = null;
  private readonly commands: CommandRunner;
  private lastAutoUpload: { path: string; kind: UploadKind; accept?: string } | null = null;
  private lastAutoUploadError: string | null = null;
  private lastRevealKey = '';
  private lastRevealAt = 0;

  constructor(commands: CommandRunner) {
    this.commands = commands;
  }

  private loadPlaywright(): PlaywrightModule {
    if (this.pw) {
      return this.pw;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.pw = require('playwright') as PlaywrightModule;
      return this.pw;
    } catch (e: any) {
      throw new Error(
        `Playwright is not available (${e?.message || e}). ` +
          `From ide-electron run: yarn add playwright && npx playwright install chromium`,
      );
    }
  }

  private isAlive(): boolean {
    return Boolean(this.page && this.context && !this.page.isClosed());
  }

  private ensureShotDir() {
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  /**
   * Seed Chromium Preferences so DevTools docks on the RIGHT at ~320px.
   * Must be written before launch (or while browser is closed).
   */
  private seedDevToolsPreferences(panel: DevToolsPanel = 'console') {
    const defaultDir = path.join(this.userDataDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefPath = path.join(defaultDir, 'Preferences');
    let data: Record<string, any> = {};
    if (fs.existsSync(prefPath)) {
      try {
        data = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      } catch {
        data = {};
      }
    }

    data.devtools = data.devtools || {};
    data.devtools.preferences = {
      ...(data.devtools.preferences || {}),
      currentDockState: '"right"',
      'last-dock-state': '"right"',
      lastDockState: '"right"',
      'panel-selected-tab': `"${panel}"`,
      'inspector-view.split-view-state': JSON.stringify({
        horizontal: { size: DEVTOOLS_DOCK_PX },
        vertical: { size: DEVTOOLS_DOCK_PX },
      }),
      'network_log.preserve-log': '"true"',
      uiTheme: '"dark"',
    };

    data.browser = data.browser || {};
    data.browser.check_default_browser = false;
    data.profile = data.profile || {};
    data.profile.exit_type = 'Normal';
    data.profile.exited_cleanly = true;

    fs.writeFileSync(prefPath, JSON.stringify(data));
  }

  private attachPageListeners(page: Page) {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        this.consoleLog.push({
          type,
          text: truncate(msg.text(), 800),
          timestamp: Date.now(),
        });
        if (this.consoleLog.length > 120) {
          this.consoleLog.shift();
        }
      }
    });
    page.on('pageerror', (err) => {
      this.consoleLog.push({
        type: 'pageerror',
        text: truncate(err?.message || String(err), 800),
        timestamp: Date.now(),
      });
      if (this.consoleLog.length > 120) {
        this.consoleLog.shift();
      }
    });
    // Never leave OS file dialogs open — auto-pick newest matching file from Downloads.
    page.on('filechooser', (chooser) => {
      void this.handleFileChooser(chooser);
    });
    page.on('response', (res) => {
      const status = res.status();
      const req = res.request();
      const resourceType = req.resourceType();
      const url = truncate(res.url(), 300);
      const method = req.method();
      const entry: NetworkRequestEntry = {
        url,
        method,
        status,
        resourceType,
        timestamp: Date.now(),
      };
      if (isApiLike(resourceType, res.url()) || status >= 400) {
        this.networkRequests.push(entry);
        if (this.networkRequests.length > 100) {
          this.networkRequests.shift();
        }
      }
      if (status >= 400) {
        this.networkFailures.push({
          url,
          method,
          status,
          timestamp: Date.now(),
        });
        if (this.networkFailures.length > 80) {
          this.networkFailures.shift();
        }
      }
    });
    page.on('requestfailed', (req) => {
      const url = truncate(req.url(), 300);
      const method = req.method();
      const error = truncate(req.failure()?.errorText || 'requestfailed', 200);
      const resourceType = req.resourceType();
      this.networkFailures.push({
        url,
        method,
        error,
        timestamp: Date.now(),
      });
      if (this.networkFailures.length > 80) {
        this.networkFailures.shift();
      }
      if (isApiLike(resourceType, req.url())) {
        this.networkRequests.push({
          url,
          method,
          resourceType,
          error,
          timestamp: Date.now(),
        });
        if (this.networkRequests.length > 100) {
          this.networkRequests.shift();
        }
      }
    });
  }

  private async handleFileChooser(chooser: import('playwright').FileChooser): Promise<void> {
    try {
      let accept: string | null = null;
      try {
        accept = await chooser.element().getAttribute('accept');
      } catch {
        accept = null;
      }
      const kind = inferUploadKind(accept);
      const file = findLatestUploadFile(kind, accept);
      if (!file) {
        this.lastAutoUploadError =
          `No matching file in Downloads/Desktop for kind=${kind}` +
          (accept ? ` accept=${accept}` : '');
        await this.showUploadToast(
          this.page,
          null,
          kind,
          'No matching file found in Downloads/Desktop',
        );
        await chooser.setFiles([]).catch(() => undefined);
        return;
      }
      // Show File Manager + banner first, then attach (user can see what is uploading)
      await this.prepareVisibleUpload(file, kind);
      await chooser.setFiles(file);
      this.lastAutoUpload = { path: file, kind, accept: accept || undefined };
      this.lastAutoUploadError = null;
    } catch (e: any) {
      this.lastAutoUploadError = e?.message || String(e);
    }
  }

  /** Open OS File Manager on the chosen file + banner in the test browser. */
  private async prepareVisibleUpload(filePath: string, kind: UploadKind): Promise<void> {
    const name = path.basename(filePath);
    const folder = path.dirname(filePath);
    const key = `${kind}:${path.resolve(filePath)}`;
    const now = Date.now();
    const alreadyShown = this.lastRevealKey === key && now - this.lastRevealAt < 2500;
    this.lastRevealKey = key;
    this.lastRevealAt = now;

    if (!alreadyShown) {
      this.revealInFileManager(filePath);
      await this.showUploadToast(
        this.page,
        filePath,
        kind,
        `Opening File Manager → selecting latest ${kind}: ${name}`,
      );
      await sleep(1100);
    }
    await this.showUploadToast(
      this.page,
      filePath,
      kind,
      `Uploading ${name} from ${folder}`,
    );
  }

  /** Reveal file in Windows Explorer / Finder / file manager (visible to the user). */
  private revealInFileManager(filePath: string): void {
    try {
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        return;
      }
      if (process.platform === 'win32') {
        // Opens Explorer with the file highlighted — user sees the selection
        spawn('explorer.exe', [`/select,${resolved}`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        }).unref();
        return;
      }
      if (process.platform === 'darwin') {
        spawn('open', ['-R', resolved], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      spawn('xdg-open', [path.dirname(resolved)], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // non-fatal — upload still proceeds
    }
  }

  /** Pink OLKIL banner inside the headed browser — stays 10s then auto-hides. */
  private async showUploadToast(
    page: Page | null,
    filePath: string | null,
    kind: UploadKind,
    message: string,
  ): Promise<void> {
    if (!page || page.isClosed()) {
      return;
    }
    try {
      await page.evaluate(
        ({ msg, kindLabel, fileName, folderPath, hideAfterMs }) => {
          const id = 'olkil-upload-toast';
          const timerKey = '__olkilUploadToastTimer';
          let el = document.getElementById(id);
          if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.setAttribute('role', 'status');
            Object.assign(el.style, {
              position: 'fixed',
              top: '16px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: '2147483647',
              maxWidth: 'min(560px, 92vw)',
              padding: '12px 16px',
              borderRadius: '12px',
              background: 'linear-gradient(165deg, #fe019a 0%, #9b0060 100%)',
              color: '#fff',
              fontFamily: 'Segoe UI, system-ui, sans-serif',
              fontSize: '13px',
              fontWeight: '600',
              lineHeight: '1.35',
              boxShadow: '0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.18)',
              pointerEvents: 'none',
              letterSpacing: '0.01em',
              opacity: '1',
              transition: 'opacity 0.35s ease',
            } as CSSStyleDeclaration);
            document.documentElement.appendChild(el);
          }
          el.style.opacity = '1';
          el.style.display = 'block';
          el.innerHTML =
            `<div style="opacity:.85;font-size:10px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:4px">OLKIL Live Test · ${kindLabel}</div>` +
            `<div>${msg}</div>` +
            (fileName
              ? `<div style="opacity:.95;font-weight:600;margin-top:6px;font-size:12px">File: ${fileName}</div>`
              : '') +
            (folderPath
              ? `<div style="opacity:.8;font-weight:500;margin-top:2px;font-size:11px;word-break:break-all">Folder: ${folderPath}</div>`
              : '') +
            `<div style="opacity:.65;font-size:10px;margin-top:8px">Visible for ${Math.round(
              hideAfterMs / 1000,
            )}s</div>`;

          const w = window as unknown as Record<string, ReturnType<typeof setTimeout> | undefined>;
          if (w[timerKey]) {
            clearTimeout(w[timerKey]);
          }
          w[timerKey] = setTimeout(() => {
            const node = document.getElementById(id);
            if (!node) {
              return;
            }
            node.style.opacity = '0';
            setTimeout(() => {
              node.remove();
            }, 400);
            w[timerKey] = undefined;
          }, hideAfterMs);
        },
        {
          msg: message,
          kindLabel: kind.toUpperCase(),
          fileName: filePath ? path.basename(filePath) : '',
          folderPath: filePath ? path.dirname(filePath) : '',
          hideAfterMs: 10_000,
        },
      );
    } catch {
      // page may be navigating
    }
  }

  /** Pick newest Downloads/Desktop file matching accept / kind / optional path. */
  resolveUploadPath(opts?: {
    path?: string;
    accept?: string | null;
    kind?: UploadKind | string;
    hint?: string;
  }): { path: string; kind: UploadKind } | { error: string } {
    if (opts?.path) {
      const p = path.resolve(opts.path);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const kind = inferUploadKind(opts.accept, opts.hint || path.extname(p));
        return { path: p, kind };
      }
      return { error: `File not found: ${opts.path}` };
    }
    const kind = (opts?.kind as UploadKind) || inferUploadKind(opts?.accept, opts?.hint);
    const file = findLatestUploadFile(kind, opts?.accept);
    if (!file) {
      return {
        error:
          `No recent ${kind} file in Downloads/Desktop. ` +
          `Put a sample file there and retry.`,
      };
    }
    return { path: file, kind };
  }

  private async attachCdp(page: Page) {
    if (!this.context) {
      return;
    }
    try {
      this.cdp?.detach().catch(() => undefined);
      this.cdp = await this.context.newCDPSession(page);
      await this.cdp.send('Network.enable').catch(() => undefined);
      await this.cdp.send('Runtime.enable').catch(() => undefined);
      await this.cdp.send('Log.enable').catch(() => undefined);
    } catch {
      this.cdp = null;
    }
  }

  async launch(headed = true, forceNew = false): Promise<BrowserActionResult> {
    const pw = this.loadPlaywright();

    if (!forceNew && this.isAlive()) {
      return {
        ok: true,
        action: 'launch',
        message: 'Browser already open — reused (DevTools preserved).',
        url: this.page?.url() || this.lastUrl,
        snapshot: '',
        consoleErrors: this.recentConsole(),
        networkFailures: this.recentNetwork(),
        networkRequests: this.recentApiRequests(),
        devtoolsOpen: this.devtoolsOpen,
      };
    }

    await this.close();
    this.consoleLog = [];
    this.networkFailures = [];
    this.networkRequests = [];
    this.devtoolsOpen = false;

    try {
      this.seedDevToolsPreferences('console');

      this.context = await pw.chromium.launchPersistentContext(this.userDataDir, {
        headless: !headed,
        viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
        ignoreHTTPSErrors: true,
        args: [
          '--disable-dev-shm-usage',
          `--install-autogenerated-theme=${OLKIL_PINK_RGB}`,
          `--window-size=${WINDOW_W},${WINDOW_H}`,
          '--window-position=100,60',
        ],
      });
      this.browser = this.context.browser();

      const pages = this.context.pages();
      this.page = pages[0] || (await this.context.newPage());
      for (const p of pages.slice(1)) {
        await p.close().catch(() => undefined);
      }

      this.attachPageListeners(this.page);
      await this.attachCdp(this.page);

      try {
        const b = this.browser;
        if (b) {
          const browserSession = await b.newBrowserCDPSession();
          try {
            const { targetInfos } = await browserSession.send('Target.getTargets');
            const pageTarget = targetInfos.find((t) => t.type === 'page');
            if (pageTarget?.targetId) {
              const { windowId } = await browserSession.send('Browser.getWindowForTarget', {
                targetId: pageTarget.targetId,
              });
              await browserSession.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                  left: 100,
                  top: 60,
                  width: WINDOW_W,
                  height: WINDOW_H,
                  windowState: 'normal',
                },
              });
            }
          } finally {
            await browserSession.detach().catch(() => undefined);
          }
        }
      } catch {
        // non-fatal
      }

      return {
        ok: true,
        action: 'launch',
        message: headed
          ? 'Chromium launched (OLKIL pink). DevTools closed by default — use browser_devtools when needed.'
          : 'Chromium launched (headless).',
        url: '',
        snapshot: '',
        consoleErrors: [],
        networkFailures: [],
        networkRequests: [],
        devtoolsOpen: false,
      };
    } catch (e: any) {
      const msg = e?.message || String(e);
      const hint = /Executable doesn't exist|browserType\.launch/i.test(msg)
        ? ' Run: npx playwright install chromium'
        : '';
      return {
        ok: false,
        action: 'launch',
        message: `Launch failed: ${msg}.${hint}`,
        url: '',
        snapshot: '',
        consoleErrors: [],
        networkFailures: [],
        error: msg,
      };
    }
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Browser not open. Call browser_launch or live_test first.');
    }
    return this.page;
  }

  private recentConsole(limit = 30): ConsoleEntry[] {
    return this.consoleLog.slice(-limit);
  }

  private recentNetwork(limit = 20): NetworkFailure[] {
    return this.networkFailures.slice(-limit);
  }

  private recentApiRequests(limit = 40): NetworkRequestEntry[] {
    return this.networkRequests.slice(-limit);
  }

  private async snapshotOf(page: Page): Promise<string> {
    try {
      const snap = await page.locator('body').ariaSnapshot({ timeout: 3500 });
      return truncate(snap || '(empty snapshot)', 8_000);
    } catch {
      try {
        const items = await page.evaluate(() => {
          const nodes = Array.from(
            document.querySelectorAll(
              'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[type="file"]',
            ),
          ).slice(0, 50);
          return nodes.map((el, i) => {
            const h = el as HTMLElement;
            const tag = h.tagName.toLowerCase();
            const role = h.getAttribute('role') || tag;
            const name =
              h.getAttribute('aria-label') ||
              (h as HTMLInputElement).placeholder ||
              h.textContent?.trim().slice(0, 60) ||
              h.getAttribute('name') ||
              '';
            const type = h.getAttribute('type') || '';
            const accept = h.getAttribute('accept') || '';
            return `- e${i + 1}: role=${role} name=${JSON.stringify(name)} type=${type}${
              accept ? ` accept=${JSON.stringify(accept)}` : ''
            }`;
          });
        });
        const title = await page.title();
        return `title: ${title}\nurl: ${page.url()}\ninteractive:\n${items.join('\n')}`;
      } catch (e: any) {
        return `snapshot failed: ${e?.message || e}`;
      }
    }
  }

  private async takeScreenshot(page: Page, label = 'shot'): Promise<string> {
    this.ensureShotDir();
    const file = path.join(
      this.screenshotDir,
      `${label}-${Date.now().toString(36)}.png`,
    );
    await page.screenshot({ path: file, fullPage: false, timeout: 8_000 });
    return file;
  }

  private uploadNote(): string {
    if (this.lastAutoUpload) {
      return ` Auto-uploaded ${this.lastAutoUpload.kind}: ${path.basename(this.lastAutoUpload.path)}.`;
    }
    if (this.lastAutoUploadError) {
      return ` Upload note: ${this.lastAutoUploadError}.`;
    }
    return '';
  }

  private async baseResult(
    action: string,
    message: string,
    opts: { screenshot?: boolean; ok?: boolean; error?: string; snap?: boolean } = {},
  ): Promise<BrowserActionResult> {
    const page = this.page;
    const url = page ? page.url() : this.lastUrl;
    let snapshot = '';
    let screenshotPath: string | undefined;
    if (page && !page.isClosed()) {
      if (opts.snap !== false) {
        snapshot = await this.snapshotOf(page);
      }
      if (opts.screenshot === true) {
        try {
          screenshotPath = await this.takeScreenshot(page, action);
        } catch {
          // non-fatal
        }
      }
    }
    const uploadSuffix = this.uploadNote();
    // Clear one-shot upload notes after reporting (avoid repeating forever)
    const lastUpload = this.lastAutoUpload
      ? { path: this.lastAutoUpload.path, kind: this.lastAutoUpload.kind }
      : undefined;
    if (uploadSuffix) {
      this.lastAutoUpload = null;
      this.lastAutoUploadError = null;
    }
    return {
      ok: opts.ok !== false,
      action,
      message: `${message}${uploadSuffix}`,
      url,
      title: page && !page.isClosed() ? await page.title().catch(() => '') : '',
      snapshot,
      screenshotPath,
      consoleErrors: this.recentConsole(),
      networkFailures: this.recentNetwork(),
      networkRequests: this.recentApiRequests(),
      devtoolsOpen: this.devtoolsOpen,
      lastUpload,
      error: opts.error,
    };
  }

  private modKey(): string {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
  }

  private normalizePanel(raw?: string): DevToolsPanel {
    const p = (raw || 'console').toLowerCase();
    if (p === 'inspect' || p === 'elements') {
      return 'elements';
    }
    if (p === 'network' || p === 'net' || p === 'api') {
      return 'network';
    }
    if (p === 'sources' || p === 'source' || p === 'debugger') {
      return 'sources';
    }
    if (p === 'application' || p === 'storage') {
      return 'application';
    }
    return 'console';
  }

  /** Ctrl/Cmd+N focuses DevTools panel when DevTools is open. */
  private async focusDevToolsPanel(panel: DevToolsPanel) {
    const page = this.requirePage();
    const mod = this.modKey();
    const map: Record<DevToolsPanel, string> = {
      elements: '1',
      console: '2',
      sources: '3',
      network: '4',
      application: '7',
    };
    const digit = map[panel] || '2';
    await page.keyboard.press(`${mod}+${digit}`);
    this.activePanel = panel;
    await sleep(200);
  }

  /**
   * Open / close / toggle Chromium DevTools.
   * Default: closed. Opens docked RIGHT (~320px) only when agent asks.
   */
  async devtools(req: BrowserDevToolsRequest = {}): Promise<BrowserActionResult> {
    const page = this.requirePage();
    const action = (req.action || 'open').toLowerCase();
    const panel = this.normalizePanel(req.panel);

    await page.bringToFront().catch(() => undefined);
    await sleep(80);

    const wantClose = action === 'close';
    const wantToggle = action === 'toggle';
    let shouldOpen = action === 'open' || action === 'show';

    if (wantToggle) {
      shouldOpen = !this.devtoolsOpen;
    }
    if (wantClose) {
      shouldOpen = false;
    }

    const mod = this.modKey();

    try {
      if (!shouldOpen) {
        if (this.devtoolsOpen) {
          await page.keyboard.press('F12');
          await sleep(250);
          this.devtoolsOpen = false;
        }
        return this.baseResult('devtools', 'DevTools closed.', { screenshot: false });
      }

      // Opening / switching panel
      if (!this.devtoolsOpen) {
        if (panel === 'console') {
          // Opens DevTools directly on Console
          await page.keyboard.press(`${mod}+Shift+J`);
        } else if (panel === 'elements') {
          await page.keyboard.press(`${mod}+Shift+C`);
        } else {
          await page.keyboard.press('F12');
          await sleep(350);
          await this.focusDevToolsPanel(panel);
        }
        this.devtoolsOpen = true;
        this.activePanel = panel;
        await sleep(300);
      } else if (panel !== this.activePanel) {
        await this.focusDevToolsPanel(panel);
      }

      const evidenceNote =
        panel === 'network'
          ? `Network panel open (right dock). Captured API calls: ${this.recentApiRequests().length}, failures: ${
              this.networkFailures.length
            }.`
          : `Console panel open (right dock). Errors/warnings: ${
              this.recentConsole().filter((e) => e.type === 'error' || e.type === 'pageerror').length
            }.`;

      return {
        ...(await this.baseResult(
          'devtools',
          `DevTools open — panel=${panel}, dock=right (~${DEVTOOLS_DOCK_PX}px). ${evidenceNote}`,
          { screenshot: false },
        )),
        networkRequests: this.recentApiRequests(40),
        consoleErrors: this.recentConsole(40),
        networkFailures: this.recentNetwork(30),
        devtoolsOpen: true,
      };
    } catch (e: any) {
      return this.baseResult('devtools', `DevTools action failed: ${e?.message || e}`, {
        ok: false,
        error: e?.message || String(e),
        screenshot: false,
      });
    }
  }

  async goto(url: string): Promise<BrowserActionResult> {
    const page = this.requirePage();
    const target = url.trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error(`Invalid URL: ${url}`);
    }
    this.lastUrl = target;
    try {
      const res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await sleep(80);
      return this.baseResult(
        'goto',
        `Navigated to ${target} (HTTP ${res?.status() ?? '?'}).`,
        { screenshot: false },
      );
    } catch (e: any) {
      return this.baseResult('goto', `Navigation issue: ${e?.message || e}`, {
        ok: false,
        error: e?.message || String(e),
        screenshot: false,
      });
    }
  }

  async reload(): Promise<BrowserActionResult> {
    const page = this.requirePage();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 });
    await sleep(60);
    return this.baseResult('reload', `Reloaded ${page.url()}.`, { screenshot: false });
  }

  private resolveLocator(page: Page, req: BrowserActionRequest) {
    if (req.testid) {
      return page.getByTestId(req.testid);
    }
    if (req.selector) {
      return page.locator(req.selector).first();
    }
    if (req.role) {
      return page.getByRole(req.role as any, req.name ? { name: req.name } : undefined).first();
    }
    if (req.text) {
      return page.getByText(req.text, { exact: Boolean(req.exact) }).first();
    }
    if (req.name) {
      return page.getByLabel(req.name).first();
    }
    throw new Error('Provide role+name, selector, text, testid, or name (label).');
  }

  async click(req: BrowserActionRequest): Promise<BrowserActionResult> {
    const page = this.requirePage();
    const loc = this.resolveLocator(page, req);
    const timeout = req.timeoutMs ?? 8_000;
    // filechooser listener auto-uploads — no OS dialog hang
    await loc.click({ timeout });
    await sleep(100);
    return this.baseResult(
      'click',
      `Clicked ${req.role || req.selector || req.text || req.testid || req.name}.`,
      { screenshot: false },
    );
  }

  async fill(req: BrowserActionRequest): Promise<BrowserActionResult> {
    const page = this.requirePage();
    if (req.value == null) {
      throw new Error('fill requires value');
    }
    const loc = this.resolveLocator(page, req);
    const timeout = req.timeoutMs ?? 8_000;

    // File inputs: setInputFiles instead of fill (avoids stuck OS dialog)
    const meta = await loc
      .evaluate((el) => {
        const h = el as HTMLInputElement;
        return {
          tag: (h.tagName || '').toLowerCase(),
          type: (h.getAttribute('type') || '').toLowerCase(),
          accept: h.getAttribute('accept') || '',
        };
      })
      .catch(() => null);

    if (meta?.type === 'file') {
      const picked = this.resolveUploadPath({
        path: String(req.value).trim() || undefined,
        accept: meta.accept,
        hint: meta.accept || 'upload',
      });
      if ('error' in picked) {
        return this.baseResult('fill', picked.error, { ok: false, error: picked.error, screenshot: false });
      }
      await this.prepareVisibleUpload(picked.path, picked.kind);
      await loc.setInputFiles(picked.path);
      this.lastAutoUpload = { path: picked.path, kind: picked.kind, accept: meta.accept || undefined };
      return this.baseResult(
        'fill',
        `Opened File Manager and uploaded ${picked.kind} file ${path.basename(picked.path)}.`,
        { screenshot: false },
      );
    }

    await loc.fill(String(req.value), { timeout });
    return this.baseResult(
      'fill',
      `Filled ${req.role || req.selector || req.name || req.testid} with ${JSON.stringify(
        truncate(String(req.value), 80),
      )}.`,
      { screenshot: false },
    );
  }

  async type(req: BrowserActionRequest): Promise<BrowserActionResult> {
    const page = this.requirePage();
    if (req.value == null) {
      throw new Error('type requires value');
    }
    const loc = this.resolveLocator(page, req);
    await loc.click({ timeout: req.timeoutMs ?? 8_000 });
    await page.keyboard.type(String(req.value), { delay: 4 });
    return this.baseResult('type', `Typed into target.`, { screenshot: false });
  }

  async press(key: string): Promise<BrowserActionResult> {
    const page = this.requirePage();
    await page.keyboard.press(key);
    return this.baseResult('press', `Pressed ${key}.`, { screenshot: false, snap: false });
  }

  async snapshot(): Promise<BrowserActionResult> {
    this.requirePage();
    return this.baseResult('snapshot', 'Captured accessibility snapshot.', {
      screenshot: false,
    });
  }

  async screenshot(): Promise<BrowserActionResult> {
    this.requirePage();
    return this.baseResult('screenshot', 'Screenshot captured.', { screenshot: true });
  }

  /** Explicit upload — picks newest matching Downloads file when path omitted. */
  async upload(req: BrowserActionRequest = {}): Promise<BrowserActionResult> {
    const page = this.requirePage();
    const picked = this.resolveUploadPath({
      path: req.value || undefined,
      accept: req.accept,
      kind: req.kind,
      hint: req.name || req.text || req.selector,
    });
    if ('error' in picked) {
      return this.baseResult('upload', picked.error, { ok: false, error: picked.error, screenshot: false });
    }

    // Prefer targeting a file input; else wait for next filechooser from a click
    try {
      // Show File Manager first so the user sees which file will be used
      await this.prepareVisibleUpload(picked.path, picked.kind);

      if (req.selector || req.role || req.name || req.testid || req.text) {
        const loc = this.resolveLocator(page, req);
        const isFile = await loc
          .evaluate((el) => (el as HTMLInputElement).type === 'file')
          .catch(() => false);
        if (isFile) {
          await loc.setInputFiles(picked.path);
        } else {
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: req.timeoutMs ?? 8_000 }),
            loc.click({ timeout: req.timeoutMs ?? 8_000 }),
          ]);
          await chooser.setFiles(picked.path);
        }
      } else {
        const fileInput = page.locator('input[type="file"]').first();
        if ((await fileInput.count()) > 0) {
          await fileInput.setInputFiles(picked.path);
        } else {
          return this.baseResult(
            'upload',
            `Resolved ${picked.path} but no file input / chooser target. Click the Upload control first.`,
            { ok: false, screenshot: false },
          );
        }
      }
      this.lastAutoUpload = { path: picked.path, kind: picked.kind };
      return this.baseResult(
        'upload',
        `Opened File Manager → selected latest ${picked.kind}: ${path.basename(picked.path)} (${picked.path}).`,
        { screenshot: false },
      );
    } catch (e: any) {
      return this.baseResult('upload', `Upload failed: ${e?.message || e}`, {
        ok: false,
        error: e?.message || String(e),
        screenshot: false,
      });
    }
  }

  async consoleDump(): Promise<BrowserActionResult> {
    this.requirePage();
    const errors = this.recentConsole(50);
    const nets = this.recentNetwork(30);
    return {
      ok: true,
      action: 'console',
      message: `${errors.filter((e) => e.type === 'error' || e.type === 'pageerror').length} error(s), ${
        nets.length
      } network failure(s).`,
      url: this.page?.url() || this.lastUrl,
      snapshot: '',
      consoleErrors: errors,
      networkFailures: nets,
      networkRequests: this.recentApiRequests(40),
      devtoolsOpen: this.devtoolsOpen,
    };
  }

  /** Structured XHR/fetch + failed requests — prefer this over opening DevTools for API diagnosis. */
  async networkDump(): Promise<BrowserActionResult> {
    this.requirePage();
    const apis = this.recentApiRequests(50);
    const fails = this.recentNetwork(30);
    const bad = apis.filter((r) => (r.status != null && r.status >= 400) || r.error);
    return {
      ok: true,
      action: 'network',
      message: `${apis.length} API/XHR request(s), ${bad.length} failing, ${fails.length} failure event(s).`,
      url: this.page?.url() || this.lastUrl,
      snapshot: '',
      consoleErrors: this.recentConsole(20),
      networkFailures: fails,
      networkRequests: apis,
      devtoolsOpen: this.devtoolsOpen,
    };
  }

  async close(): Promise<BrowserActionResult> {
    try {
      await this.cdp?.detach().catch(() => undefined);
      this.cdp = null;
      // Persistent context: closing context closes browser
      await this.context?.close().catch(() => undefined);
      if (this.browser?.isConnected()) {
        await this.browser.close().catch(() => undefined);
      }
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
      this.devtoolsOpen = false;
    }
    return {
      ok: true,
      action: 'close',
      message: 'Browser closed.',
      url: this.lastUrl,
      snapshot: '',
      consoleErrors: this.recentConsole(),
      networkFailures: this.recentNetwork(),
      networkRequests: this.recentApiRequests(),
      devtoolsOpen: false,
    };
  }

  /**
   * Smart prepare: detect/start app → wait for URL → launch headed browser → snapshot.
   * Agent then drives clicks/fills and fix loop.
   */
  async liveTest(request: LiveTestRequest): Promise<LiveTestResult> {
    const root = path.resolve(request.workspaceRoot || process.cwd());
    const detect = this.commands.detectDevServer(root);
    const headed = request.headed !== false;
    const startApp = request.startApp !== false;

    let commandId: string | undefined;
    let command: string | undefined;
    let urls: string[] = [];
    const notes: string[] = [];

    if (startApp) {
      const running = this.commands.list().filter((c) => c.running && c.urls.length);
      if (running.length) {
        commandId = running[0].id;
        urls = running[0].urls;
        notes.push(`Reusing running command ${commandId}`);
      } else if (detect.recommendedCommand) {
        command = detect.recommendedCommand;
        const run = await this.commands.run({
          command,
          cwd: root,
          background: true,
          settleMs: 1200,
        });
        commandId = run.id;
        urls = run.urls.length ? run.urls : detect.suggestedUrls;
        notes.push(`Started: ${command}`);
        if (run.stderr && /error|ERR!/i.test(run.stderr) && run.exitCode != null) {
          notes.push(`Dev server may have failed: ${truncate(run.stderr, 400)}`);
        }
      } else {
        notes.push('No start script found — expecting url to already be reachable.');
        urls = detect.suggestedUrls;
      }
    } else {
      urls = detect.suggestedUrls;
    }

    let target =
      (request.url || '').trim() ||
      urls[0] ||
      detect.suggestedUrls[0] ||
      'http://127.0.0.1:3000';

    if (!request.url && commandId) {
      const deadline = Date.now() + (request.readyTimeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        const out = this.commands.getOutput(commandId);
        if (out?.urls?.length) {
          target = out.urls[0];
          urls = out.urls;
          break;
        }
        for (const candidate of detect.suggestedUrls) {
          const probe = await waitForHttp(candidate, 600);
          if (probe.ok) {
            target = candidate;
            urls = [candidate];
            break;
          }
        }
        if (urls.length && urls[0] === target && (await waitForHttp(target, 600)).ok) {
          break;
        }
        await sleep(350);
      }
    }

    const ready = await waitForHttp(target, request.readyTimeoutMs ?? 15_000);
    if (!ready.ok) {
      notes.push(`URL not ready (${target}): ${ready.error || 'unknown'}`);
    }

    // Reuse existing browser so inspect/DevTools is not torn down
    const launch = await this.launch(headed, false);
    if (!launch.ok) {
      return {
        ok: false,
        url: target,
        commandId,
        command,
        detect,
        notes,
        result: launch,
        error: launch.error || launch.message,
      };
    }

    const nav = await this.goto(target);
    if (request.goal) {
      notes.push(`Goal: ${request.goal}`);
    }
      notes.push(
        'File uploads: File Manager opens with the latest matching file selected (Downloads/Desktop), plus an on-page OLKIL banner — so you can see what is uploading.',
      );
    notes.push(
      'Next: browser_snapshot → click/fill (fast). Prefer browser_console / browser_network for evidence. browser_devtools only if needed.',
    );

    return {
      ok: nav.ok && ready.ok,
      url: target,
      commandId,
      command,
      detect,
      notes,
      result: nav,
      error: !ready.ok ? `App not reachable at ${target}` : nav.error,
    };
  }

  /** Used by extractLocalUrls tests / helpers */
  static urlsFromText(text: string): string[] {
    return extractLocalUrls(text);
  }
}
