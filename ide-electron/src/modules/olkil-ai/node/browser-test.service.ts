import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
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
        const req = lib.get(url, { timeout: 2500 }, (res) => {
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
    await sleep(700);
  }
  return { ok: false, error: lastError || 'Timed out waiting for URL' };
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
   * Values are double-encoded strings — Chromium DevTools convention.
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
      // Chromium stores DevTools pref values as JSON-encoded strings (extra quotes).
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

  private async attachCdp(page: Page) {
    if (!this.context) {
      return;
    }
    try {
      this.cdp?.detach().catch(() => undefined);
      this.cdp = await this.context.newCDPSession(page);
      // Enable domains the agent relies on for accurate evidence
      await this.cdp.send('Network.enable').catch(() => undefined);
      await this.cdp.send('Runtime.enable').catch(() => undefined);
      await this.cdp.send('Log.enable').catch(() => undefined);
    } catch {
      this.cdp = null;
    }
  }

  async launch(headed = true, forceNew = false): Promise<BrowserActionResult> {
    const pw = this.loadPlaywright();

    // Reuse session so DevTools / page state is not wiped mid-debug
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
      // Prefs before launch: right dock, narrow panel — DevTools stays CLOSED until agent asks
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
          // Do NOT pass --auto-open-devtools-for-tabs (on-demand only)
        ],
      });
      this.browser = this.context.browser();

      const pages = this.context.pages();
      this.page = pages[0] || (await this.context.newPage());
      // Close extra blank tabs from profile restore
      for (const p of pages.slice(1)) {
        await p.close().catch(() => undefined);
      }

      this.attachPageListeners(this.page);
      await this.attachCdp(this.page);

      // Ensure window bounds are comfortable (not huge)
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
        // non-fatal — headed window still usable
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
      const snap = await page.locator('body').ariaSnapshot({ timeout: 8000 });
      return truncate(snap || '(empty snapshot)', 12_000);
    } catch {
      try {
        const items = await page.evaluate(() => {
          const nodes = Array.from(
            document.querySelectorAll(
              'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]',
            ),
          ).slice(0, 60);
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
            return `- e${i + 1}: role=${role} name=${JSON.stringify(name)} type=${type}`;
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
    await page.screenshot({ path: file, fullPage: false });
    return file;
  }

  private async baseResult(
    action: string,
    message: string,
    opts: { screenshot?: boolean; ok?: boolean; error?: string } = {},
  ): Promise<BrowserActionResult> {
    const page = this.page;
    const url = page ? page.url() : this.lastUrl;
    let snapshot = '';
    let screenshotPath: string | undefined;
    if (page && !page.isClosed()) {
      snapshot = await this.snapshotOf(page);
      if (opts.screenshot !== false) {
        try {
          screenshotPath = await this.takeScreenshot(page, action);
        } catch {
          // non-fatal
        }
      }
    }
    return {
      ok: opts.ok !== false,
      action,
      message,
      url,
      title: page && !page.isClosed() ? await page.title().catch(() => '') : '',
      snapshot,
      screenshotPath,
      consoleErrors: this.recentConsole(),
      networkFailures: this.recentNetwork(),
      networkRequests: this.recentApiRequests(),
      devtoolsOpen: this.devtoolsOpen,
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
    // Keep DevTools open across navigations — do not relaunch
    try {
      const res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(400);
      return this.baseResult(
        'goto',
        `Navigated to ${target} (HTTP ${res?.status() ?? '?'}).`,
      );
    } catch (e: any) {
      return this.baseResult('goto', `Navigation issue: ${e?.message || e}`, {
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  async reload(): Promise<BrowserActionResult> {
    const page = this.requirePage();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(300);
    return this.baseResult('reload', `Reloaded ${page.url()}.`);
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
    await loc.click({ timeout: req.timeoutMs ?? 12_000 });
    await sleep(250);
    return this.baseResult(
      'click',
      `Clicked ${req.role || req.selector || req.text || req.testid || req.name}.`,
    );
  }

  async fill(req: BrowserActionRequest): Promise<BrowserActionResult> {
    const page = this.requirePage();
    if (req.value == null) {
      throw new Error('fill requires value');
    }
    const loc = this.resolveLocator(page, req);
    await loc.fill(String(req.value), { timeout: req.timeoutMs ?? 12_000 });
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
    await loc.click({ timeout: req.timeoutMs ?? 12_000 });
    await page.keyboard.type(String(req.value), { delay: 12 });
    return this.baseResult('type', `Typed into target.`, { screenshot: false });
  }

  async press(key: string): Promise<BrowserActionResult> {
    const page = this.requirePage();
    await page.keyboard.press(key);
    return this.baseResult('press', `Pressed ${key}.`, { screenshot: false });
  }

  async snapshot(): Promise<BrowserActionResult> {
    this.requirePage();
    return this.baseResult('snapshot', 'Captured accessibility snapshot.', {
      screenshot: false,
    });
  }

  async screenshot(): Promise<BrowserActionResult> {
    this.requirePage();
    return this.baseResult('screenshot', 'Screenshot captured.');
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
          settleMs: 2200,
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
      const deadline = Date.now() + (request.readyTimeoutMs ?? 45_000);
      while (Date.now() < deadline) {
        const out = this.commands.getOutput(commandId);
        if (out?.urls?.length) {
          target = out.urls[0];
          urls = out.urls;
          break;
        }
        for (const candidate of detect.suggestedUrls) {
          const probe = await waitForHttp(candidate, 900);
          if (probe.ok) {
            target = candidate;
            urls = [candidate];
            break;
          }
        }
        if (urls.length && urls[0] === target && (await waitForHttp(target, 900)).ok) {
          break;
        }
        await sleep(1000);
      }
    }

    const ready = await waitForHttp(target, request.readyTimeoutMs ?? 20_000);
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
      'Next: browser_snapshot → click/fill. Prefer browser_console / browser_network for evidence. Open browser_devtools only when you need the visible Console/Network panel (right dock). Close with action=close when done.',
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
