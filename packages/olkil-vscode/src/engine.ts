import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { OLKIL_HOME, type OlkilSession } from './auth';
import { hydrateEngineKey, type EngineCreds } from './quota';
import {
  CLOUD_MODELS,
  extraCloudModels,
  customEndpointReady,
  customIdFromModelId,
  customProviderId,
  normalizeOpenAiBaseUrl,
  resolveCloudSlug,
  type CustomEndpoint,
} from './models';

const OPENCODE_VERSION = process.env.OPENCODE_VERSION || 'v1.18.22';
const BIN_DIR = path.join(OLKIL_HOME, 'opencode-bin', OPENCODE_VERSION);
const OPENCODE_EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
const OPENCODE_HOME_DIR = path.join(OLKIL_HOME, 'vscode-opencode-home');
const IDENTITY_FILE = path.join(OPENCODE_HOME_DIR, 'AGENTS.md');
const AUTH_FILE = path.join(OPENCODE_HOME_DIR, 'auth.json');
const CONFIG_FILE = path.join(OPENCODE_HOME_DIR, 'opencode.json');
const PLUGIN_FILE = path.join(OPENCODE_HOME_DIR, 'plugin', 'olkil-compat.mjs');

const OLKIL_IDENTITY = `# OLKIL

You are OLKIL, a coding agent. Product name is OLKIL.
If asked who you are: I am OLKIL, the coding agent.
If asked which model: I run on OLKIL's coding model.
Never mention OpenCode, Cursor, Cline, ChatGPT, or a provider slug.

You only work in Agent mode. Never plan-only, never ask-only, never spawn explore/task subagents.
When the user wants a change: grep/read the matching files, then immediately edit or write.
Do not dump search findings, tables, or a report instead of editing.
Do not ask for confirmation. After edits, 1–2 sentences on what changed.
Stay inside the workspace. Do not run npm/yarn/pnpm/vite/next build unless asked.
`;

export type EngineEventHandler = (event: Record<string, unknown>) => void;

function mkdirp(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file: string, data: unknown) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function opencodeAsset() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'win32' && arch === 'arm64') return 'opencode-windows-arm64.zip';
  if (plat === 'win32') return 'opencode-windows-x64.zip';
  if (plat === 'darwin' && arch === 'arm64') return 'opencode-darwin-arm64.zip';
  if (plat === 'darwin') return 'opencode-darwin-x64.zip';
  if (arch === 'arm64') return 'opencode-linux-arm64.tar.gz';
  return 'opencode-linux-x64.tar.gz';
}

function findBinary(dir: string, depth: number): string | null {
  if (depth > 3 || !dir) return null;
  try {
    const direct = path.join(dir, OPENCODE_EXE);
    if (fs.existsSync(direct) && fs.statSync(direct).size > 5 * 1024 * 1024) return direct;
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(child);
      } catch {
        continue;
      }
      if (st.isFile() && name === OPENCODE_EXE && st.size > 5 * 1024 * 1024) return child;
      if (st.isDirectory() && !name.startsWith('.')) {
        const nested = findBinary(child, depth + 1);
        if (nested) return nested;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function downloadFile(url: string, dest: string) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error('download failed ' + res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

export async function ensureOpencodeBinary(): Promise<string> {
  const envBin = process.env.OLKIL_OPENCODE_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const cached = path.join(BIN_DIR, OPENCODE_EXE);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 5 * 1024 * 1024) return cached;
  mkdirp(BIN_DIR);
  const name = opencodeAsset();
  const url = 'https://github.com/anomalyco/opencode/releases/download/' + OPENCODE_VERSION + '/' + name;
  const tmp = path.join(os.tmpdir(), 'olkil-vscode-' + name);
  const extract = path.join(BIN_DIR, '.extract');
  await downloadFile(url, tmp);
  if (fs.existsSync(extract)) fs.rmSync(extract, { recursive: true, force: true });
  mkdirp(extract);
  if (process.platform === 'win32') {
    execSync(
      'powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath \'' +
        tmp.replace(/'/g, "''") +
        "' -DestinationPath '" +
        extract.replace(/'/g, "''") +
        "' -Force\"",
      { stdio: 'ignore' },
    );
  } else if (name.endsWith('.zip')) {
    execSync('unzip -o "' + tmp + '" -d "' + extract + '"', { stdio: 'ignore' });
  } else {
    execSync('tar -xzf "' + tmp + '" -C "' + extract + '"', { stdio: 'ignore' });
  }
  const found = findBinary(extract, 0);
  if (!found) throw new Error('Coding engine missing from archive');
  fs.copyFileSync(found, cached);
  if (process.platform !== 'win32') fs.chmodSync(cached, 0o755);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return cached;
}

function resolveStoredCreds(): EngineCreds | null {
  const auth = readJson<any>(AUTH_FILE, {});
  if (auth.openrouter?.key) {
    return {
      provider: 'openrouter',
      baseURL: String(auth.openrouter.baseURL || 'https://openrouter.ai/api/v1'),
      apiKey: String(auth.openrouter.key),
      model: String(auth.openrouter.model || 'deepseek/deepseek-v4-flash'),
    };
  }
  if (auth.deepseek?.key) {
    return {
      provider: 'deepseek',
      baseURL: String(auth.deepseek.baseURL || 'https://api.deepseek.com/v1'),
      apiKey: String(auth.deepseek.key),
      model: String(auth.deepseek.model || 'deepseek-v4-flash'),
    };
  }
  return null;
}

function writeCompatPlugin() {
  mkdirp(path.dirname(PLUGIN_FILE));
  fs.writeFileSync(
    PLUGIN_FILE,
    `export default async function olkilCompat() {
  function stripReasoningFields(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 8) return;
    if (Array.isArray(obj)) {
      for (const item of obj) stripReasoningFields(item, depth + 1);
      return;
    }
    delete obj.reasoning_content;
    delete obj.reasoning_details;
    if (obj.providerOptions) stripReasoningFields(obj.providerOptions, depth + 1);
    if (obj.native) stripReasoningFields(obj.native, depth + 1);
    if (obj.metadata) stripReasoningFields(obj.metadata, depth + 1);
    if (obj.openaiCompatible) stripReasoningFields(obj.openaiCompatible, depth + 1);
  }
  return {
    "chat.params": async function (_input, output) {
      if (!output || !output.options || typeof output.options !== "object") return;
      delete output.options.textVerbosity;
      delete output.options.verbosity;
      delete output.options.reasoningSummary;
      delete output.options.reasoning;
      const text = output.options.text;
      if (text && typeof text === "object" && !Array.isArray(text)) delete text.verbosity;
    },
    "experimental.chat.messages.transform": async function (_input, output) {
      const messages = output && output.messages;
      if (!Array.isArray(messages)) return;
      for (const row of messages) {
        if (Array.isArray(row.parts)) {
          for (let i = row.parts.length - 1; i >= 0; i--) {
            const t = String((row.parts[i] && row.parts[i].type) || "");
            if (t === "reasoning" || t === "redacted_reasoning") row.parts.splice(i, 1);
          }
        }
        stripReasoningFields(row.info, 0);
        stripReasoningFields(row, 0);
      }
    },
  };
}
`,
    'utf8',
  );
}

function modelFlags(id: string, name: string) {
  return {
    id,
    name,
    tool_call: true,
    temperature: true,
    reasoning: false,
    limit: { context: 128000, output: 8192 },
  };
}

function readyCustoms(list: CustomEndpoint[] | CustomEndpoint | null | undefined): CustomEndpoint[] {
  const rows = Array.isArray(list) ? list : list ? [list] : [];
  return rows.filter((c) => c && customEndpointReady(c) && c.id);
}

function olkilConfig(cloud: EngineCreds | null, customs: CustomEndpoint[] | CustomEndpoint | null) {
  const provider: Record<string, unknown> = {};
  const enabled: string[] = [];
  if (cloud) {
    const providerId = cloud.provider === 'openrouter' ? 'openrouter' : 'deepseek';
    enabled.push(providerId);
    const models: Record<string, unknown> = {};
    if (cloud.provider === 'openrouter') {
      for (const m of [...CLOUD_MODELS, ...extraCloudModels()]) {
        if (m.id === 'auto' || m.slug === 'auto') continue;
        models[m.slug] = modelFlags(m.slug, m.label);
      }
    } else {
      models[cloud.model] = modelFlags(cloud.model, 'OLKIL');
    }
    provider[providerId] = {
      npm: '@ai-sdk/openai-compatible',
      name: 'OLKIL',
      options: {
        baseURL: cloud.baseURL,
        apiKey: cloud.apiKey,
        timeout: 300000,
        headers: {
          'HTTP-Referer': 'https://olkil.com',
          'X-Title': 'OLKIL',
        },
      },
      models,
    };
  }
  for (const custom of readyCustoms(customs)) {
    const pid = customProviderId(custom.id);
    enabled.push(pid);
    const model = custom.model.trim();
    provider[pid] = {
      npm: '@ai-sdk/openai-compatible',
      name: custom.model.trim() || 'Custom',
      options: {
        baseURL: normalizeOpenAiBaseUrl(custom.baseUrl),
        apiKey: custom.apiKey.trim(),
        timeout: 300000,
      },
      models: {
        [model]: modelFlags(model, model),
      },
    };
  }
  const tools = {
    write: true,
    edit: true,
    bash: true,
    read: true,
    grep: true,
    glob: true,
    patch: true,
    task: false,
    question: false,
  };
  return {
    $schema: 'https://opencode.ai/config.json',
    username: 'OLKIL',
    autoupdate: false,
    share: 'disabled',
    logLevel: 'WARN',
    enabled_providers: enabled,
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'deny',
    },
    compaction: { auto: false },
    default_agent: 'build',
    instructions: [IDENTITY_FILE.replace(/\\/g, '/')],
    agent: {
      build: {
        description: 'OLKIL coding agent',
        color: '#FF2D8C',
        mode: 'primary',
        prompt: OLKIL_IDENTITY,
        tools,
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
        },
      },
      plan: { disable: true },
      explore: { disable: true },
      general: { disable: true },
    },
    provider,
    plugin: [PLUGIN_FILE.replace(/\\/g, '/')],
  };
}

function runtimeEnv(password: string, cloud: EngineCreds | null, customs: CustomEndpoint[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/_API_KEY$/i.test(k) || /^OPENCODE_/.test(k)) delete env[k];
  }
  const extra: NodeJS.ProcessEnv = {
    OPENCODE_CALLER: 'olkil',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_HOME: OPENCODE_HOME_DIR,
    OPENCODE_CONFIG_DIR: OPENCODE_HOME_DIR,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(olkilConfig(cloud, customs)),
    OPENCODE_SERVER_USERNAME: 'olkil',
    OPENCODE_SERVER_PASSWORD: password,
    XDG_CONFIG_HOME: path.join(OLKIL_HOME, 'xdg-config'),
  };
  if (cloud?.provider === 'openrouter') extra.OPENROUTER_API_KEY = cloud.apiKey;
  else if (cloud) extra.DEEPSEEK_API_KEY = cloud.apiKey;
  return Object.assign(env, extra);
}

function wrapUserPrompt(user: string, directory: string, turns: number): string {
  const text = String(user || '').trim();
  const mandate =
    'Agent mode: edit or write the matching files now. Do not use task/explore. Do not write a findings report.';
  if (turns > 1) return text + '\n\n' + mandate;
  const bits: string[] = [];
  if (directory) bits.push('Workspace: ' + directory + '. Stay inside this folder.');
  bits.push("You are OLKIL's coding agent. Never say you are OpenCode, Cursor, Cline, ChatGPT, or Claude.");
  bits.push('Never run npm run build, yarn build, pnpm build, vite build, or next build unless asked.');
  bits.push(mandate);
  bits.push(text);
  return bits.join('\n\n');
}

function stopChild(proc: ChildProcess) {
  if (!proc || proc.exitCode != null) return;
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}

export class OlkilEngine {
  url = '';
  private proc: ChildProcess | null = null;
  private authHeader = '';
  private listeners = new Set<EngineEventHandler>();
  private eventReq: http.ClientRequest | null = null;
  private starting: Promise<void> | null = null;
  sessionId = '';
  directory = '';
  private creds: EngineCreds | null = null;
  private customs: CustomEndpoint[] = [];
  private bootDir = '';
  private bootKey = '';
  private sessionTurns = 0;

  onEvent(handler: EngineEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async prepare(
    session: OlkilSession,
    directory: string,
    custom?: CustomEndpoint | CustomEndpoint[] | null,
    useCloud = true,
  ) {
    this.directory = directory;
    this.customs = readyCustoms(custom);
    mkdirp(OPENCODE_HOME_DIR);
    fs.writeFileSync(IDENTITY_FILE, OLKIL_IDENTITY);
    writeCompatPlugin();
    if (useCloud) {
      const creds = (await hydrateEngineKey(session)) || resolveStoredCreds();
      if (creds) {
        this.creds = creds;
        const auth = readJson<any>(AUTH_FILE, {});
        auth[creds.provider] = {
          type: 'api',
          key: creds.apiKey,
          baseURL: creds.baseURL,
          model: creds.model,
        };
        writeJson(AUTH_FILE, auth);
        try {
          fs.chmodSync(AUTH_FILE, 0o600);
        } catch {
          /* windows */
        }
      }
    } else {
      this.creds = null;
    }
    writeJson(CONFIG_FILE, olkilConfig(this.creds, this.customs));
  }

  private bootFingerprint() {
    return [
      this.creds?.apiKey || '',
      this.customs.map((c) => [c.id, c.model, c.baseUrl, c.apiKey].join(':')).join(','),
      String(extraCloudModels().length),
      'compat-reasoning-1',
    ].join('|');
  }

  async ensureStarted(
    session: OlkilSession,
    directory: string,
    custom?: CustomEndpoint | CustomEndpoint[] | null,
    useCloud = true,
  ): Promise<void> {
    await this.prepare(session, directory, custom, useCloud);
    const key = this.bootFingerprint();
    const same =
      this.url &&
      this.proc &&
      this.proc.exitCode == null &&
      this.bootDir === directory &&
      this.bootKey === key;
    if (same) return;
    if (this.proc && this.proc.exitCode == null) {
      this.stopEvents();
      stopChild(this.proc);
      this.proc = null;
      this.url = '';
      this.sessionId = '';
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
    this.bootDir = directory;
    this.bootKey = key;
  }

  private async start() {
    const bin = await ensureOpencodeBinary();
    const creds = this.creds || resolveStoredCreds();
    this.creds = creds;
    if (!creds && !this.customs.length) {
      throw new Error('Could not load the OLKIL coding engine key. Sign in and try again, or add a custom model.');
    }
    const port = 20000 + Math.floor(Math.random() * 20000);
    const password = crypto.randomBytes(16).toString('hex');
    this.authHeader = 'Basic ' + Buffer.from('olkil:' + password).toString('base64');
    this.proc = spawn(bin, ['serve', '--hostname=127.0.0.1', '--port=' + port], {
      cwd: OPENCODE_HOME_DIR,
      env: runtimeEnv(password, creds, this.customs),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const expected = 'http://127.0.0.1:' + port;
    await this.waitForListen(expected);
    this.url = expected.endsWith('/') ? expected : expected + '/';
    this.listenEvents();
  }

  private waitForListen(expected: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = this.proc!;
      let output = '';
      let settled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        if (err) {
          stopChild(proc);
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Engine did not start.\n' + output.slice(-1200))), 25000);
      const onData = (chunk: Buffer) => {
        output += String(chunk);
        if (/opencode server listening/i.test(output)) finish();
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('exit', (code) => finish(new Error('Engine exited with code ' + code)));
      poll = setInterval(() => {
        const req = http.get(
          expected.replace(/\/$/, '') + '/global/health',
          { headers: { Authorization: this.authHeader }, timeout: 1200 },
          (res) => {
            res.resume();
            if ((res.statusCode || 0) < 500) finish();
          },
        );
        req.on('error', () => undefined);
      }, 400);
    });
  }

  request<T = any>(method: string, pathname: string, body?: unknown, timeoutMs = 25000): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.url);
      if (this.directory) url.searchParams.set('directory', this.directory);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: {
            Authorization: this.authHeader,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d) => chunks.push(d as Buffer));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new Error(method + ' ' + pathname + ' failed (' + status + '): ' + raw.slice(0, 400)));
              return;
            }
            if (!raw) return resolve(undefined as T);
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(raw as T);
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(method + ' ' + pathname + ' timed out'));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private listenEvents() {
    this.stopEvents();
    const target = new URL('/global/event', this.url);
    const connect = () => {
      this.eventReq = http.get(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
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
              const dataLines = String(block)
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim());
              if (!dataLines.length) continue;
              const data = dataLines.join('\n');
              if (!data || data === '[DONE]') continue;
              try {
                const payload = JSON.parse(data);
                const event =
                  payload && payload.payload && typeof payload.payload === 'object' && payload.payload.type
                    ? payload.payload
                    : payload;
                this.listeners.forEach((fn) => fn(event));
              } catch {
                /* ignore */
              }
            }
          });
          res.on('end', () => setTimeout(connect, 400));
        },
      );
      this.eventReq.on('error', () => setTimeout(connect, 800));
    };
    connect();
  }

  private stopEvents() {
    if (this.eventReq) {
      try {
        this.eventReq.destroy();
      } catch {
        /* ignore */
      }
      this.eventReq = null;
    }
  }

  async newSession() {
    const created = await this.request<any>('POST', '/session', { title: 'OLKIL' });
    const id = created && (created.id || created.data?.id);
    if (!id) throw new Error('Could not start a chat session.');
    this.sessionId = String(id);
    this.sessionTurns = 0;
    return this.sessionId;
  }

  currentCreds(): EngineCreds | null {
    return this.creds || resolveStoredCreds();
  }

  usingCustom(): boolean {
    return this.customs.length > 0;
  }

  async sendPrompt(text: string, modelId?: string) {
    if (!this.sessionId) await this.newSession();
    this.sessionTurns += 1;
    const creds = this.creds || resolveStoredCreds();
    const cid = customIdFromModelId(modelId);
    const custom = cid ? this.customs.find((c) => c.id === cid) : undefined;
    const useCustom = Boolean(custom && customEndpointReady(custom));
    const slug = resolveCloudSlug(modelId || creds?.model);
    const model = useCustom && custom
      ? { providerID: customProviderId(custom.id), modelID: custom.model.trim() }
      : creds
        ? { providerID: creds.provider, modelID: creds.provider === 'openrouter' ? slug : creds.model }
        : { providerID: 'openrouter', modelID: slug };
    const body = {
      agent: 'build',
      model,
      tools: {
        write: true,
        edit: true,
        bash: true,
        read: true,
        grep: true,
        glob: true,
        patch: true,
        task: false,
        question: false,
      },
      parts: [{ type: 'text', text: wrapUserPrompt(text, this.directory, this.sessionTurns) }],
    };
    try {
      await this.request('POST', '/session/' + this.sessionId + '/prompt_async', body, 20000);
    } catch {
      await this.request('POST', '/session/' + this.sessionId + '/prompt', body, 180000);
    }
  }

  async abort() {
    if (!this.sessionId) return;
    try {
      await this.request('POST', '/session/' + this.sessionId + '/abort');
    } catch {
      /* ignore */
    }
  }

  async replyPermission(id: string, response: 'always' | 'reject' = 'always') {
    if (!this.sessionId || !id) return;
    try {
      await this.request('POST', '/session/' + this.sessionId + '/permissions/' + id, { response });
    } catch {
      /* ignore */
    }
  }

  dispose() {
    this.stopEvents();
    if (this.proc) stopChild(this.proc);
    this.proc = null;
    this.url = '';
    this.sessionId = '';
    this.bootDir = '';
    this.bootKey = '';
    this.sessionTurns = 0;
  }
}
