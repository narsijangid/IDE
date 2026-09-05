import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ensureOpencodeBinary, resolveOpencodeBinary } from './binary';
import { buildOpencodeConfigContent, type OpencodeProviderSecrets } from './config';
import type { CustomModelEndpoint } from '../../common/models';
import { opencodeCustomProviderId } from '../../common/models';

export interface OpencodeHttpOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export type OpencodeEventHandler = (event: any) => void;

export class OpencodeSidecar {
  url = '';
  private proc: ChildProcess | null = null;
  private eventReq: http.ClientRequest | null = null;
  private listeners = new Set<OpencodeEventHandler>();
  private starting: Promise<void> | null = null;
  private homeDir = '';
  private authHeader = '';

  constructor(
    private readonly secrets: OpencodeProviderSecrets,
    private readonly extras?: { mcp?: Record<string, unknown>; customModels?: CustomModelEndpoint[] },
  ) {}

  async ensureStarted(): Promise<string> {
    if (this.url && this.proc && this.proc.exitCode == null) {
      return this.url;
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
    return this.url;
  }

  onEvent(handler: OpencodeEventHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async request<T = any>(method: string, pathname: string, options: OpencodeHttpOptions = {}): Promise<T> {
    const base = this.url || (await this.ensureStarted());
    const url = new URL(pathname, base);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    return httpRequest<T>(url, method, payload, options.signal, this.authHeader);
  }

  close(): void {
    this.stopEvents();
    if (this.proc) {
      stopChild(this.proc);
      this.proc = null;
    }
    this.url = '';
  }

  private async start(): Promise<void> {
    let binary: string | undefined;
    try {
      binary = await ensureOpencodeBinary();
    } catch (err) {
      binary = resolveOpencodeBinary();
      if (!binary) {
        throw new Error(
          `Preparing the AI engine failed (${err instanceof Error ? err.message : err}). Check your internet connection and try again.`,
        );
      }
    }
    if (!binary) {
      throw new Error('Preparing the AI engine… If this persists, check your internet connection and reopen OLKIL.');
    }
    this.homeDir = path.join(os.homedir(), '.olkil', 'opencode-home');
    fs.mkdirSync(this.homeDir, { recursive: true });
    this.writeProviderAuth();
    fs.mkdirSync(path.join(this.homeDir, 'config'), { recursive: true });
    const plugin = writeStripGatewayPlugin(this.homeDir);

    const port = 20000 + Math.floor(Math.random() * 20000);
    const password = randomBytes(16).toString('hex');
    this.authHeader = `Basic ${Buffer.from(`olkil:${password}`).toString('base64')}`;
    // Do not pass --pure: that skips config plugins, including the verbosity stripper.
    // Isolation is OPENCODE_DISABLE_PROJECT_CONFIG + a dedicated CONFIG_DIR.
    const args = ['serve', `--hostname=127.0.0.1`, `--port=${port}`];
    const config = buildOpencodeConfigContent(this.secrets, {
      ...this.extras,
      plugin: [plugin],
    });
    const env: NodeJS.ProcessEnv = isolatedSidecarEnv({
      OPENCODE_HOME: this.homeDir,
      OPENCODE_CONFIG_DIR: path.join(this.homeDir, 'config'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_CALLER: 'olkil',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_SERVER_USERNAME: 'olkil',
      OPENCODE_SERVER_PASSWORD: password,
      DEEPSEEK_API_KEY: this.secrets.deepseekKey || '',
      POOLSIDE_API_KEY: this.secrets.poolsideKey || '',
    });

    const proc = spawn(binary, args, {
      cwd: this.homeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    const url = await waitForListen(proc, port, 25000, this.authHeader);
    this.url = url.endsWith('/') ? url : `${url}/`;
    await this.waitHealthy(8000);
    this.attachExitHandler(proc);
    this.startEventStream();
  }

  /** OpenCode also reads auth.json; keep it in sync so packaged users don't 401. */
  private writeProviderAuth(): void {
    const auth: Record<string, { type: 'api'; key: string }> = {};
    if (this.secrets.deepseekKey) {
      auth.deepseek = { type: 'api', key: this.secrets.deepseekKey };
    }
    if (this.secrets.poolsideKey) {
      auth.poolside = { type: 'api', key: this.secrets.poolsideKey };
    }
    for (const ep of this.extras?.customModels || []) {
      if (ep.apiKey) {
        auth[opencodeCustomProviderId(ep.id)] = { type: 'api', key: ep.apiKey };
      }
    }
    fs.writeFileSync(path.join(this.homeDir, 'auth.json'), JSON.stringify(auth), 'utf8');
  }

  private attachExitHandler(proc: ChildProcess): void {
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.url = '';
        this.stopEvents();
        if (code && code !== 0) {
          console.warn(`[olkil-opencode] sidecar exited with code ${code}`);
        }
      }
    });
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const health = await this.request<{ healthy?: boolean }>('GET', '/global/health');
        if (health?.healthy !== false) {
          return;
        }
      } catch {
        // retry
      }
      await sleep(200);
    }
  }

  private startEventStream(): void {
    this.stopEvents();
    if (!this.url) {
      return;
    }
    const connect = () => {
      if (!this.url || !this.proc) {
        return;
      }
      const target = new URL('/global/event', this.url);
      const req = http.get(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          headers: { Accept: 'text/event-stream', Authorization: this.authHeader },
        },
        (res) => {
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', (chunk: string) => {
            buffer += chunk;
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              const event = parseSseBlock(block);
              if (event) {
                this.emit(event);
              }
            }
          });
          res.on('end', () => {
            if (this.proc && this.url) {
              setTimeout(connect, 400).unref?.();
            }
          });
        },
      );
      req.on('error', () => {
        if (this.proc && this.url) {
          setTimeout(connect, 800).unref?.();
        }
      });
      this.eventReq = req;
    };
    connect();
  }

  private emit(raw: any): void {
    const event = raw?.payload && typeof raw.payload === 'object' && raw.payload.type ? raw.payload : raw;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  private stopEvents(): void {
    if (this.eventReq) {
      try {
        this.eventReq.destroy();
      } catch {
        // ignore
      }
      this.eventReq = null;
    }
  }
}

function parseSseBlock(block: string): any | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) {
    return null;
  }
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Don't inherit the user's OPENAI_API_KEY / other vendor keys — OpenCode's
 * openai-compatible DeepSeek adapter will 401 "Authentication Fails (governor)"
 * if a foreign key wins over ours.
 */
function isolatedSidecarEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/_API_KEY$/i.test(key) || /_ACCESS_TOKEN$/i.test(key) || key === 'OPENAI_API_KEY') {
      delete env[key];
    }
  }
  delete env.OPENCODE_PURE;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG_CONTENT;
  Object.assign(env, overrides);
  return env;
}

/**
 * OpenCode 1.18.21 injects textVerbosity for gpt-5.x on openai-compatible
 * providers. Gateways then 400: verbosity is not supported by this profile.
 * Strip it (and nested text.verbosity) before the request is sent.
 */
function writeStripGatewayPlugin(homeDir: string): string {
  const dir = path.join(homeDir, 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'olkil-strip-gateway-params.mjs');
  fs.writeFileSync(
    file,
    `export default async function olkilStripGatewayParams() {
  return {
    "chat.params": async function (_input, output) {
      if (!output || !output.options || typeof output.options !== "object") {
        return;
      }
      delete output.options.textVerbosity;
      delete output.options.verbosity;
      delete output.options.reasoningSummary;
      const text = output.options.text;
      if (text && typeof text === "object" && !Array.isArray(text)) {
        delete text.verbosity;
      }
    },
  };
}
`,
    'utf8',
  );
  return file;
}

function waitForListen(proc: ChildProcess, port: number, timeoutMs: number, authHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const expected = `http://127.0.0.1:${port}`;
    let poll: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => {
      probeHealth(expected, authHeader)
        .then((ok) => {
          if (ok) {
            finish(undefined, expected);
            return;
          }
          finish(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms\n${output.slice(-2000)}`));
        })
        .catch(() => {
          finish(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms\n${output.slice(-2000)}`));
        });
    }, timeoutMs);

    poll = setInterval(() => {
      probeHealth(expected, authHeader).then((ok) => {
        if (ok) {
          finish(undefined, expected);
        }
      });
    }, 400);

    const onData = (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      output += String(chunk);
      const match = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
      if (match?.[1]) {
        finish(undefined, match[1].replace(/\/$/, ''));
      }
    };

    const finish = (error?: Error, url?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (poll) {
        clearInterval(poll);
      }
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onData);
      proc.off('exit', onExit);
      proc.off('error', onError);
      if (error) {
        stopChild(proc);
        reject(error);
        return;
      }
      resolve(url || '');
    };

    const onExit = (code: number | null) => {
      finish(new Error(`OpenCode sidecar exited with code ${code}\n${output.slice(-2000)}`));
    };
    const onError = (error: Error) => finish(error);

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', onExit);
    proc.on('error', onError);
  });
}

function stopChild(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32' && proc.pid) {
    const out = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    if (!out.error && out.status === 0) {
      return;
    }
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
}

function httpRequest<T>(
  url: URL,
  method: string,
  payload?: string,
  signal?: AbortSignal,
  authHeader?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`OpenCode ${method} ${url.pathname} failed (${status}): ${raw.slice(0, 800)}`));
            return;
          }
          if (status === 204 || !raw) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            resolve(raw as T);
          }
        });
      },
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          req.destroy();
          reject(new Error('aborted'));
        },
        { once: true },
      );
    }
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function probeHealth(base: string, authHeader?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL('/global/health', base.endsWith('/') ? base : `${base}/`);
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: 1500,
        headers: authHeader ? { Authorization: authHeader } : undefined,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
