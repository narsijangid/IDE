#!/usr/bin/env node
'use strict';

/**
 * OLKIL CLI — Google login, plan check, then OLKIL chat in the project folder.
 * OpenCode runs headless as the coding engine. The terminal UI is OLKIL.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

const VERSION = '1.0.22';
const OPENCODE_VERSION = process.env.OPENCODE_VERSION || 'v1.18.21';
const ORIGIN = (process.env.OLKIL_AUTH_ORIGIN || 'https://olkil.com').replace(/\/$/, '');
const FIREBASE_API_KEY = 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = { providerID: 'deepseek', modelID: 'deepseek-v4-flash' };
const HOME = path.join(os.homedir(), '.olkil');
const SESSION_FILE = path.join(HOME, 'auth-session.json');
const TRUST_FILE = path.join(HOME, 'trusted-workspaces.json');
const PREFS_FILE = path.join(HOME, 'cli-prefs.json');
const BIN_DIR = path.join(HOME, 'opencode-bin');
const OPENCODE_EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
const OPENCODE_HOME_DIR = path.join(HOME, 'opencode-home');
const IDENTITY_FILE = path.join(OPENCODE_HOME_DIR, 'AGENTS.md');
const ENGINE_PLUGIN_FILE = path.join(OPENCODE_HOME_DIR, 'plugin', 'olkil-engine.mjs');

const OLKIL_IDENTITY = `# OLKIL

You are OLKIL, the OLKIL coding agent.

If the user asks who you are, answer exactly: I am OLKIL, the coding agent.
If the user asks which model you use, answer exactly: I run on OLKIL's coding model.
Never print a provider id, model slug, vendor name, or product other than OLKIL.

Never mention OpenCode, opencode, SST, anomalyco, Big Pickle, big-pickle, or opencode.ai.
Do not fetch opencode.ai. Do not use WebFetch for identity, branding, or "what model" questions.
Never say you are powered by another product. Branding in every reply is OLKIL only.
Lead with the answer. Be a sharp, calm coding partner. Keep replies tight unless the user asks for more.
`;

const PINK = '#FF2D8C';
const PEACH = '#FFC09A';
const MUTED = '#71717A';
const FG = '#F4F4F5';
const LINE = '#27272A';
const PANEL = '#111114';
const BOX = '#1A1A1E';
const BOX_EDGE = '#2A2A32';
const GREEN = '#61FFCA';
const RED = '#FF6767';
const LOGO = [
  ' ██████╗ ██╗     ██╗  ██╗██╗██╗     ',
  '██╔═══██╗██║     ██║ ██╔╝██║██║     ',
  '██║   ██║██║     █████╔╝ ██║██║     ',
  '██║   ██║██║     ██╔═██╗ ██║██║     ',
  '╚██████╔╝███████╗██║  ██╗██║███████╗',
  ' ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝',
];
const LOGO_COLORS = [PEACH, PINK, '#FF4DA6', '#FFFFFF', '#D4D4D8', MUTED];

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
};

function log(msg) {
  process.stdout.write(msg + '\n');
}

function ok(msg) {
  log(c.green + '✓ ' + c.reset + msg);
}

function warn(msg) {
  log(c.yellow + msg + c.reset);
}

function fail(msg) {
  log(c.red + '✗ ' + c.reset + msg);
}

function banner() {
  log('');
  log(c.bold + c.magenta + '  OLKIL' + c.reset + c.dim + '  cli ' + VERSION + c.reset);
  log('');
}

function help() {
  banner();
  log('  olkil              Sign in, trust this folder, open OLKIL chat');
  log('  olkil .            Use the current directory');
  log('  olkil <path>       Use a project folder');
  log('  olkil login        Google sign-in in the browser');
  log('  olkil logout       Clear the saved session');
  log('  olkil whoami       Show account and plan');
  log('  olkil --help       This help');
  log('');
  log(c.dim + '  olkil is separate from the opencode command. It does not replace OpenCode on PATH.' + c.reset);
  log('');
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function pluginPathForConfig(file) {
  return file.replace(/\\/g, '/');
}

function resolveDeepseekKey() {
  const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (envKey && !/your_|changeme|placeholder/i.test(envKey)) return envKey;
  try {
    const auth = readJson(path.join(OPENCODE_HOME_DIR, 'auth.json'), {});
    const k = auth.deepseek && auth.deepseek.key;
    if (k && String(k).trim()) return String(k).trim();
  } catch {
    /* ignore */
  }
  return '';
}

async function hydrateEngineKey(session) {
  const cached = resolveDeepseekKey();
  try {
    const res = await httpsJson(ORIGIN + '/wp-json/olkil-payu/v1/engine', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.idToken },
      body: { id_token: session.idToken, email: (session.user && session.user.email) || '' },
    });
    const key = String((res.json && (res.json.apiKey || res.json.key)) || '').trim();
    if (key) {
      const auth = readJson(path.join(OPENCODE_HOME_DIR, 'auth.json'), {});
      auth.deepseek = { type: 'api', key };
      writeJson(path.join(OPENCODE_HOME_DIR, 'auth.json'), auth);
      return key;
    }
  } catch {
    /* keep cached */
  }
  return cached;
}

function deepseekModels() {
  const ids = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
  const out = {};
  for (const id of ids) {
    out[id] = {
      id,
      name: id === 'deepseek-v4-flash' ? 'OLKIL' : 'OLKIL Pro',
      tool_call: true,
      temperature: true,
      reasoning: false,
      limit: { context: 128000, output: 8192 },
    };
  }
  return out;
}

function olkilOpencodeConfig(pluginSpec, key) {
  const apiKey = key || resolveDeepseekKey();
  return {
    $schema: 'https://opencode.ai/config.json',
    username: 'OLKIL',
    autoupdate: false,
    share: 'disabled',
    logLevel: 'WARN',
    enabled_providers: ['deepseek'],
    plugin: pluginSpec ? [pluginSpec] : [],
    instructions: [pluginPathForConfig(IDENTITY_FILE)],
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'deny',
    },
    compaction: { auto: false },
    agent: {
      build: { description: 'OLKIL coding agent', color: PINK },
    },
    provider: {
      deepseek: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OLKIL',
        options: {
          baseURL: DEEPSEEK_BASE,
          apiKey,
          timeout: 300000,
        },
        models: deepseekModels(),
      },
    },
  };
}

function enginePluginSource() {
  return `export default async function olkilEngine() {
  const brand = ${JSON.stringify(OLKIL_IDENTITY)};
  return {
    "permission.ask": async function (input, output) {
      const kind = String((input && (input.permission || input.type || input.tool)) || "").toLowerCase();
      output.status = /external/.test(kind) ? "deny" : "allow";
    },
    "experimental.chat.system.transform": async function (_input, output) {
      if (!output || !Array.isArray(output.system) || !output.system.length) return;
      const first = String(output.system[0] || "");
      if (first.indexOf("You are OLKIL") >= 0) return;
      output.system[0] = brand + "\\n\\n" + first;
    },
    "experimental.text.complete": async function (_input, output) {
      if (!output || typeof output.text !== "string") return;
      output.text = output.text
        .replace(/\\bI'm OpenCode\\b/gi, "I'm OLKIL")
        .replace(/\\bI am OpenCode\\b/gi, "I am OLKIL")
        .replace(/\\bthis is OpenCode\\b/gi, "this is OLKIL")
        .replace(/\\bOpenCode (IDE|assistant|agent)\\b/gi, "OLKIL $1")
        .replace(/\\bBig Pickle\\b/gi, "OLKIL");
    },
  };
}
`;
}

function looksLikeOlkilLeak(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return /You are OLKIL/.test(t) || /Never say you are OpenCode/.test(t) || /Never print a provider id/.test(t);
  } catch {
    return false;
  }
}

function tryUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function globalOpencodeRoots() {
  const roots = [path.join(os.homedir(), '.config', 'opencode'), path.join(os.homedir(), '.opencode')];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'opencode'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'opencode'));
  return roots;
}

function scrubGlobalOpencode() {
  for (const root of globalOpencodeRoots()) {
    const agents = path.join(root, 'AGENTS.md');
    if (looksLikeOlkilLeak(agents)) tryUnlink(agents);
    tryUnlink(path.join(root, 'themes', 'olkil.json'));
    tryUnlink(path.join(root, 'plugins', 'olkil-brand.tsx'));
    tryUnlink(path.join(root, 'plugin', 'olkil-brand.tsx'));
    tryUnlink(path.join(root, 'tui.json'));
  }
}

function writeOlkilRuntime() {
  mkdirp(path.dirname(ENGINE_PLUGIN_FILE));
  mkdirp(path.join(HOME, 'xdg-config'));
  mkdirp(path.join(HOME, 'xdg-data'));
  mkdirp(path.join(HOME, 'xdg-state'));
  mkdirp(OPENCODE_HOME_DIR);
  fs.writeFileSync(IDENTITY_FILE, OLKIL_IDENTITY);
  fs.writeFileSync(ENGINE_PLUGIN_FILE, enginePluginSource());
  tryUnlink(path.join(OPENCODE_HOME_DIR, 'tui.json'));
  tryUnlink(path.join(OPENCODE_HOME_DIR, 'plugins', 'olkil-brand.tsx'));
  tryUnlink(path.join(OPENCODE_HOME_DIR, 'themes', 'olkil.json'));
  scrubGlobalOpencode();
  const key = resolveDeepseekKey();
  const pluginSpec = pluginPathForConfig(ENGINE_PLUGIN_FILE);
  writeJson(path.join(OPENCODE_HOME_DIR, 'opencode.json'), olkilOpencodeConfig(pluginSpec, key));
  const auth = readJson(path.join(OPENCODE_HOME_DIR, 'auth.json'), {});
  auth.deepseek = { type: 'api', key };
  writeJson(path.join(OPENCODE_HOME_DIR, 'auth.json'), auth);
  const prefs = readJson(PREFS_FILE, {});
  if (!prefs.model || /opencode|big-pickle/i.test(String(prefs.model))) {
    prefs.model = 'deepseek/deepseek-v4-flash';
    writeJson(PREFS_FILE, prefs);
  }
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function httpsJson(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: Object.assign(
          {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'OLKIL-CLI/' + VERSION,
          },
          opts.headers || {},
          body ? { 'Content-Length': Buffer.byteLength(body) } : {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, json: null, raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 8) return reject(new Error('too many redirects'));
      https
        .get(u, { headers: { 'User-Agent': 'OLKIL-CLI/' + VERSION } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(res.headers.location, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('download failed ' + res.statusCode));
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(dest)));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    go(url, 0);
  });
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

function findBinary(dir, depth) {
  if (depth > 3 || !dir) return null;
  try {
    const direct = path.join(dir, OPENCODE_EXE);
    if (fs.existsSync(direct) && fs.statSync(direct).size > 5 * 1024 * 1024) return direct;
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      let st;
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

async function ensureOpencode() {
  const envBin = process.env.OLKIL_OPENCODE_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const cached = path.join(BIN_DIR, OPENCODE_EXE);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 5 * 1024 * 1024) return cached;
  const branded = path.join(BIN_DIR, process.platform === 'win32' ? 'olkil-runtime.exe' : 'olkil-runtime');
  if (fs.existsSync(branded) && fs.statSync(branded).size > 5 * 1024 * 1024) return branded;
  mkdirp(BIN_DIR);
  const name = opencodeAsset();
  const url = 'https://github.com/anomalyco/opencode/releases/download/' + OPENCODE_VERSION + '/' + name;
  const tmp = path.join(os.tmpdir(), 'olkil-' + name);
  const extract = path.join(BIN_DIR, '.extract');
  log(c.dim + 'Preparing the coding engine…' + c.reset);
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
      { stdio: 'ignore' }
    );
  } else if (name.endsWith('.zip')) {
    execSync('unzip -o "' + tmp + '" -d "' + extract + '"', { stdio: 'ignore' });
  } else {
    execSync('tar -xzf "' + tmp + '" -C "' + extract + '"', { stdio: 'ignore' });
  }
  const found = findBinary(extract, 0);
  if (!found) throw new Error('Coding engine missing from archive');
  try {
    fs.copyFileSync(found, cached);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && fs.existsSync(cached)) {
      return cached;
    }
    throw err;
  }
  if (process.platform !== 'win32') fs.chmodSync(cached, 0o755);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return cached;
}

async function refreshSession(session) {
  if (!session || !session.refreshToken) return null;
  if (session.expiresAt && Date.now() < session.expiresAt - 60 * 1000) return session;
  const res = await httpsJson(
    'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(FIREBASE_API_KEY),
    {
      method: 'POST',
      body: { grant_type: 'refresh_token', refresh_token: session.refreshToken },
    }
  );
  if (!res.json || !res.json.id_token) return session;
  session.idToken = res.json.id_token;
  session.refreshToken = res.json.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + Number(res.json.expires_in || 3600) * 1000;
  writeJson(SESSION_FILE, session);
  return session;
}

function loadSession() {
  return readJson(SESSION_FILE, null);
}

function clearSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
      return;
    }
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    log('Open this URL in your browser:\n' + url);
  }
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

function loginWithBrowser() {
  return new Promise((resolve, reject) => {
    const state = randomState();
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const finish = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        server.close();
        resolve(payload);
      };
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.state && body.state !== state) {
              res.writeHead(400);
              res.end('bad state');
              return;
            }
            finish({
              idToken: body.id_token || body.idToken,
              refreshToken: body.refresh_token || body.refreshToken,
            });
          } catch {
            res.writeHead(400);
            res.end('bad json');
          }
        });
        return;
      }
      finish({
        idToken: url.searchParams.get('id_token'),
        refreshToken: url.searchParams.get('refresh_token'),
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = 'http://127.0.0.1:' + port + '/callback';
      const auth =
        ORIGIN +
        '/auth/ide/?state=' +
        encodeURIComponent(state) +
        '&redirect_uri=' +
        encodeURIComponent(redirectUri) +
        '&client=olkil-cli&protocol=olkil';
      log('Signing in with the browser...');
      openBrowser(auth);
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        reject(new Error('Login timed out. Run olkil login again.'));
      }, 5 * 60 * 1000);
    });
    server.on('error', reject);
  });
}

async function completeLogin() {
  const tokens = await loginWithBrowser();
  if (!tokens || !tokens.idToken) throw new Error('No tokens from browser');
  const payload = decodeJwt(tokens.idToken) || {};
  const session = {
    user: {
      uid: payload.user_id || payload.sub || '',
      email: payload.email || null,
      displayName: payload.name || null,
      photoURL: payload.picture || null,
    },
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3500 * 1000,
  };
  writeJson(SESSION_FILE, session);
  ok('Signed in.');
  return session;
}

async function ensureSession() {
  let session = loadSession();
  if (session) {
    session = await refreshSession(session);
    if (session && session.idToken) return session;
  }
  return completeLogin();
}

async function fetchQuota(session) {
  const res = await httpsJson(ORIGIN + '/wp-json/olkil-payu/v1/quota', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.idToken },
    body: { id_token: session.idToken, email: (session.user && session.user.email) || '' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Google session expired. Run olkil login again.');
  }
  if (!res.json || res.status < 200 || res.status >= 300) {
    throw new Error('Plan check failed (HTTP ' + res.status + ').');
  }
  return res.json;
}

function trustedList() {
  const data = readJson(TRUST_FILE, { dirs: [] });
  return Array.isArray(data.dirs) ? data.dirs : [];
}

function rememberTrust(dir) {
  const dirs = trustedList();
  if (!dirs.includes(dir)) {
    dirs.push(dir);
    writeJson(TRUST_FILE, { dirs });
  }
}

function askTrust(dir) {
  return new Promise((resolve) => {
    if (trustedList().includes(dir)) return resolve(true);
    if (!process.stdin.isTTY) {
      rememberTrust(dir);
      return resolve(true);
    }
    log('');
    log('  ' + c.bold + c.magenta + 'Trust this folder?' + c.reset);
    log('  OLKIL can edit files and run commands here.');
    log('');
    log('  ' + c.dim + dir + c.reset);
    log('');
    log('  ' + c.magenta + 'a' + c.reset + '  trust     ' + c.dim + 'q' + c.reset + '  quit');
    log('');
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      const key = String(ch).toLowerCase();
      if (key === 'a' || key === '\r' || key === '\n') {
        cleanup();
        rememberTrust(dir);
        resolve(true);
      } else if (key === 'q' || key === '\u0003') {
        cleanup();
        resolve(false);
      }
    };
    function cleanup() {
      stdin.removeListener('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(!!wasRaw);
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

function pricingUrl(quota, sub) {
  return (sub && sub.upgrade_url) || (quota && quota.upgrade_url) || ORIGIN + '/pricing/';
}

function denyPlan(title, lines, url) {
  log('');
  fail(title);
  log('');
  lines.forEach((line) => log('  ' + line));
  log('');
  log(c.dim + '  ' + url + c.reset);
  log('');
  process.exit(1);
}

function assertCloudPlan(quota) {
  const sub = (quota && (quota.subscription || quota)) || {};
  const reason = String((quota && quota.reason) || '');
  const planName = String(sub.plan_name || sub.plan || 'Dazzlone');
  const spendable = Number(sub.spendable_left || sub.tokens_left || 0);
  const allowed = quota && (quota.allowed === true || quota.cloud_allowed === true);
  const url = pricingUrl(quota, sub);
  const leftLabel = sub.spendable_left_label || sub.tokens_left_label || '';
  const totalLabel = sub.tokens_total_label || '';

  if (allowed && spendable > 0) {
    return { sub, planName, leftLabel, totalLabel };
  }

  if (reason === 'quota_exceeded' || (sub.is_paid && spendable < 1)) {
    denyPlan(
      'No tokens left on ' + planName + '.',
      [
        planName + (totalLabel ? ' includes ' + totalLabel + ' tokens per period.' : ' token allowance is used up.'),
        'Buy ' + planName + ' again for a fresh 30-day window, or upgrade:',
        'Lite $3 · 100M   Pro $10 · 350M   Ultra $49 · 2B',
      ],
      url
    );
  }

  if (reason === 'expired') {
    denyPlan(
      'Your paid plan has expired.',
      ['You are back on Dazzlone (free). The CLI needs Lite, Pro, or Ultra.', 'Renew at olkil.com/pricing.'],
      url
    );
  }

  denyPlan(
    'Please upgrade to Lite, Pro, or Ultra.',
    [
      'Signed in as a free Dazzlone account. Cloud agents are not included.',
      'Lite  $3   ·  100M tokens / month',
      'Pro   $10  ·  350M tokens / month',
      'Ultra $49  ·  2B tokens / month',
    ],
    url
  );
}

async function whoami() {
  const session = await ensureSession();
  const quota = await fetchQuota(session);
  const sub = quota.subscription || quota;
  log((session.user && session.user.email) || 'signed in');
  log('Plan: ' + (sub.plan_name || sub.plan || 'Dazzlone'));
  if (sub.tokens_left_label) {
    log('Tokens left: ' + sub.tokens_left_label + (sub.tokens_total_label ? ' / ' + sub.tokens_total_label : ''));
  }
  if (quota.allowed !== true) {
    log(c.yellow + (quota.message || 'Upgrade to Lite, Pro, or Ultra to use the CLI.') + c.reset);
    if (quota.upgrade_url || sub.upgrade_url) log(c.dim + (sub.upgrade_url || quota.upgrade_url) + c.reset);
  }
}

function hexRgb(hex) {
  const n = String(hex || '').replace('#', '');
  return {
    r: parseInt(n.slice(0, 2), 16) || 0,
    g: parseInt(n.slice(2, 4), 16) || 0,
    b: parseInt(n.slice(4, 6), 16) || 0,
  };
}

function fg(hex, text) {
  const { r, g, b } = hexRgb(hex);
  return '\x1b[38;2;' + r + ';' + g + ';' + b + 'm' + text + '\x1b[39m';
}

function bg(hex, text) {
  const { r, g, b } = hexRgb(hex);
  return '\x1b[48;2;' + r + ';' + g + ';' + b + 'm' + text + '\x1b[49m';
}

function chip(bgHex, fgHex, text) {
  return bg(bgHex, fg(fgHex, text));
}

function visLen(s) {
  return String(s)
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

function padVis(s, width, align) {
  const n = visLen(s);
  if (n >= width) return s;
  const fill = ' '.repeat(width - n);
  return align === 'right' ? fill + s : s + fill;
}

function clipVis(s, width) {
  const str = String(s);
  if (visLen(str) <= width) return str;
  let out = '';
  let n = 0;
  const parts = str.split(/(\x1b\[[0-9;?]*[A-Za-z])/);
  for (const part of parts) {
    if (!part) continue;
    if (part.charCodeAt(0) === 27) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (n >= width - 1) {
        return out + '…';
      }
      out += ch;
      n += 1;
    }
  }
  return out;
}

function wrapText(text, width) {
  const w = Math.max(12, width);
  const lines = [];
  for (const para of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!para) {
      lines.push('');
      continue;
    }
    let rest = para;
    while (visLen(rest) > w) {
      const raw = rest.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      let cut = raw.lastIndexOf(' ', w);
      if (cut < Math.floor(w * 0.45)) cut = w;
      lines.push(raw.slice(0, cut));
      rest = raw.slice(cut).replace(/^ /, '');
    }
    lines.push(rest);
  }
  return lines;
}

function shortDir(dir) {
  const parts = String(dir || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  if (!parts.length) return 'workspace';
  return parts.slice(-2).join('/') || parts[parts.length - 1];
}

function brandText(s) {
  return String(s || '')
    .replace(/https?:\/\/opencode\.ai/gi, 'https://olkil.com')
    .replace(/\bOpenCode\b/g, 'OLKIL')
    .replace(/\bopencode\b/g, 'OLKIL')
    .replace(/Big\s*Pickle/gi, 'OLKIL')
    .replace(/\bbig-pickle\b/gi, 'OLKIL')
    .replace(/\banomalyco\b/gi, 'OLKIL');
}

function sessionIdOf(event) {
  return String(
    (event && event.properties && (event.properties.sessionID || (event.properties.part && event.properties.part.sessionID) || (event.properties.info && event.properties.info.sessionID))) ||
      ''
  );
}

function permissionIdOf(permission) {
  return String(
    (permission && (permission.id || permission.permissionID || permission.requestID || (permission.info && permission.info.id))) ||
      ''
  );
}

function errorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String((error.data && error.data.message) || error.message || error.name || error);
}

function toolLabel(part) {
  const name = String((part && part.tool) || 'tool');
  if (/^(invalid|todoread)$/i.test(name)) return '';
  const input = (part && part.state && part.state.input) || {};
  const target = String(
    input.path || input.file_path || input.filePath || input.target_file || input.glob || input.pattern || input.command || ''
  );
  const short = target
    ? target
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .slice(-2)
        .join('/')
    : '';
  if (/^bash$/i.test(name)) return short ? 'run  ' + clipVis(short, 48) : 'run command';
  if (/^todowrite$/i.test(name)) return 'plan';
  return (name + (short ? '  ' + short : '')).trim();
}

function parseSseBlock(block) {
  const dataLines = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isolatedSidecarEnv(overrides) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/_API_KEY$/i.test(key) || /_ACCESS_TOKEN$/i.test(key) || key === 'OPENAI_API_KEY') delete env[key];
    if (/^OPENCODE_/.test(key)) delete env[key];
  }
  delete env.OPENCODE_BIN;
  return Object.assign(env, overrides);
}

function olkilRuntimeEnv(password) {
  const pluginSpec = pluginPathForConfig(ENGINE_PLUGIN_FILE);
  const key = resolveDeepseekKey();
  return isolatedSidecarEnv({
    OPENCODE_CALLER: 'olkil',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_TERMINAL_TITLE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_HOME: OPENCODE_HOME_DIR,
    OPENCODE_CONFIG_DIR: OPENCODE_HOME_DIR,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(olkilOpencodeConfig(pluginSpec, key)),
    OPENCODE_SERVER_USERNAME: 'olkil',
    OPENCODE_SERVER_PASSWORD: password,
    DEEPSEEK_API_KEY: key,
    XDG_CONFIG_HOME: path.join(HOME, 'xdg-config'),
    XDG_DATA_HOME: path.join(HOME, 'xdg-data'),
    XDG_STATE_HOME: path.join(HOME, 'xdg-state'),
    COLORTERM: 'truecolor',
  });
}

function stopChild(proc) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  if (process.platform === 'win32' && proc.pid) {
    const out = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    if (!out.error && out.status === 0) return;
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}

function sidecarRequest(base, authHeader, method, pathname, query, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base.endsWith('/') ? base : base + '/');
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Authorization: authHeader,
      Accept: 'application/json',
    };
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
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error('engine ' + method + ' ' + url.pathname + ' failed (' + status + '): ' + raw.slice(0, 600)));
            return;
          }
          if (status === 204 || !raw) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        });
      }
    );
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('engine ' + method + ' ' + pathname + ' timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function probeHealth(base, authHeader) {
  return new Promise((resolve) => {
    const url = new URL('/global/health', base.endsWith('/') ? base : base + '/');
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: 1500,
        headers: { Authorization: authHeader },
      },
      (res) => {
        res.resume();
        resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForListen(proc, port, timeoutMs, authHeader) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const expected = 'http://127.0.0.1:' + port;
    const timer = setTimeout(() => {
      probeHealth(expected, authHeader).then((okHealth) => {
        if (okHealth) finish(undefined, expected);
        else finish(new Error('Engine did not start.\n' + output.slice(-1800)));
      });
    }, timeoutMs);
    const poll = setInterval(() => {
      probeHealth(expected, authHeader).then((okHealth) => {
        if (okHealth) finish(undefined, expected);
      });
    }, 400);
    const onData = (chunk) => {
      output += String(chunk);
      const match = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
      if (match && match[1]) finish(undefined, match[1].replace(/\/$/, ''));
    };
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      proc.stdout && proc.stdout.off('data', onData);
      proc.stderr && proc.stderr.off('data', onData);
      proc.off('exit', onExit);
      proc.off('error', onError);
      if (error) {
        stopChild(proc);
        reject(error);
        return;
      }
      resolve(url || expected);
    };
    const onExit = (code) => finish(new Error('Engine exited with code ' + code + '\n' + output.slice(-1800)));
    const onError = (err) => finish(err);
    proc.stdout && proc.stdout.on('data', onData);
    proc.stderr && proc.stderr.on('data', onData);
    proc.on('exit', onExit);
    proc.on('error', onError);
  });
}

function startEventStream(base, authHeader, onEvent) {
  let req = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const target = new URL('/global/event', base.endsWith('/') ? base : base + '/');
    req = http.get(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: { Accept: 'text/event-stream', Authorization: authHeader },
      },
      (res) => {
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const raw = parseSseBlock(block);
            if (!raw) continue;
            const event = raw.payload && typeof raw.payload === 'object' && raw.payload.type ? raw.payload : raw;
            try {
              onEvent(event);
            } catch {
              /* ignore */
            }
          }
        });
        res.on('end', () => {
          if (closed) return;
          const t = setTimeout(connect, 400);
          if (t.unref) t.unref();
        });
      }
    );
    req.on('error', () => {
      if (!closed) setTimeout(connect, 800);
    });
  };
  connect();
  return () => {
    closed = true;
    if (req) {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
    }
  };
}

async function startSidecar(bin) {
  mkdirp(OPENCODE_HOME_DIR);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const password = crypto.randomBytes(16).toString('hex');
  const authHeader = 'Basic ' + Buffer.from('olkil:' + password).toString('base64');
  const proc = spawn(bin, ['serve', '--hostname=127.0.0.1', '--port=' + port], {
    cwd: OPENCODE_HOME_DIR,
    env: olkilRuntimeEnv(password),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const url = await waitForListen(proc, port, 25000, authHeader);
  return { proc, url: url.endsWith('/') ? url : url + '/', authHeader, password };
}

function preferredModel() {
  const prefs = readJson(PREFS_FILE, {});
  const raw = String(prefs.model || 'deepseek/deepseek-v4-flash');
  const i = raw.indexOf('/');
  const providerID = i > 0 ? raw.slice(0, i) : 'deepseek';
  const modelID = i > 0 ? raw.slice(i + 1) : raw;
  if (providerID === 'opencode' || /big-pickle|zen/i.test(modelID)) return DEFAULT_MODEL;
  if (providerID === 'deepseek') return { providerID, modelID: modelID || 'deepseek-v4-flash' };
  return DEFAULT_MODEL;
}

function parseUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = Number(raw.prompt_tokens || raw.promptTokens || raw.input || 0) || 0;
  const completion = Number(raw.completion_tokens || raw.completionTokens || raw.output || 0) || 0;
  const total = Number(raw.total_tokens || raw.total || 0) || prompt + completion;
  if (total < 1) return null;
  const cache = raw.cache && typeof raw.cache === 'object' ? raw.cache : {};
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cacheHitTokens: Number(raw.prompt_cache_hit_tokens || cache.read || 0) || 0,
    cacheMissTokens: Number(raw.prompt_cache_miss_tokens || 0) || 0,
    reasoningTokens: Number(raw.reasoning_tokens || raw.reasoning || 0) || 0,
  };
}

function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

async function chargeUsage(session, usage) {
  if (!session || !session.idToken || !usage || usage.totalTokens < 1) return null;
  const res = await httpsJson(ORIGIN + '/wp-json/olkil-payu/v1/usage', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.idToken },
    body: {
      tokens: usage.totalTokens,
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      prompt_cache_hit_tokens: usage.cacheHitTokens,
      prompt_cache_miss_tokens: usage.cacheMissTokens,
      reasoning_tokens: usage.reasoningTokens,
      model: DEFAULT_MODEL.modelID,
      provider: 'deepseek',
      request_id: 'cli-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      id_token: session.idToken,
      email: (session.user && session.user.email) || '',
    },
  });
  return res && res.json ? res.json : null;
}

function tokenLabel(meta) {
  if (meta.leftLabel) return meta.leftLabel;
  const n = Number(meta.spendable);
  if (!Number.isFinite(n) || n < 0) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function centerText(s, w) {
  const n = visLen(s);
  if (n >= w) return clipVis(s, w);
  const left = Math.floor((w - n) / 2);
  return ' '.repeat(left) + s;
}

function bgPad(hex, text, width) {
  const { r, g, b } = hexRgb(hex);
  const bgCode = '\x1b[48;2;' + r + ';' + g + ';' + b + 'm';
  const t = String(text || '').replace(/\x1b\[(?:0|39|49)m/g, (m) => m + bgCode);
  const n = visLen(t);
  const fill = n >= width ? clipVis(t, width) : t + ' '.repeat(width - n);
  return bgCode + fill + '\x1b[0m';
}

function restoreTerminal() {
  try {
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m');
  } catch {
    /* ignore */
  }
}

function runOlkilChat(api, meta) {
  return new Promise((resolve) => {
    const state = {
      messages: [],
      input: '',
      cursor: 0,
      scroll: 0,
      busy: false,
      status: 'ready',
      tick: 0,
      sessionId: '',
      childIds: new Set(),
      userMessageIds: new Set(),
      history: [],
      histIdx: -1,
      draft: '',
      usage: null,
      done: false,
    };

    let stopEvents = () => {};
    let spinner = null;
    let drawTimer = null;
    let exiting = false;

    const model = preferredModel();

    function liveMsg() {
      return state.messages.find((m) => m.live);
    }

    function scheduleDraw() {
      if (drawTimer) return;
      drawTimer = setTimeout(() => {
        drawTimer = null;
        draw();
      }, 32);
    }

    function cols() {
      return Math.max(48, process.stdout.columns || 80);
    }

    function rows() {
      return Math.max(16, process.stdout.rows || 24);
    }

    function buildTranscript(width) {
      const inner = Math.max(20, width - 6);
      const lines = [];
      for (const msg of state.messages) {
        lines.push('');
        if (msg.role === 'user') {
          lines.push(fg(PEACH, 'YOU'));
          for (const w of wrapText(msg.text, inner)) lines.push(fg(FG, w));
        } else if (msg.role === 'system') {
          for (const w of wrapText(msg.text, inner)) lines.push(fg(MUTED, w));
        } else {
          const tag = msg.live ? state.status || 'working' : '';
          lines.push(fg(PINK, 'OLKIL') + (tag ? fg(MUTED, '  ·  ' + tag) : ''));
          for (const tool of msg.tools || []) {
            const mark = tool.done ? fg(GREEN, '·') : fg(PEACH, '·');
            lines.push('  ' + mark + ' ' + fg(MUTED, tool.label));
          }
          const body = brandText(msg.text || '');
          if (body) {
            for (const w of wrapText(body, inner)) lines.push(fg(FG, w));
          } else if (msg.live && !(msg.tools && msg.tools.length)) {
            lines.push(fg(MUTED, 'working' + '.'.repeat(state.tick % 4)));
          }
          if (msg.error) {
            for (const w of wrapText(msg.error, inner)) lines.push(fg(RED, w));
          }
        }
      }
      return lines;
    }

    function paint(frameLines, cursor, w, h) {
      const lines = frameLines.slice(0, h);
      while (lines.length < h) lines.push('');
      let out = '\x1b[?25l\x1b[H';
      for (let i = 0; i < h; i++) {
        out += padVis(clipVis(lines[i], w), w) + '\x1b[K\x1b[0m';
        if (i < h - 1) out += '\n';
      }
      const row = Math.max(0, Math.min(h - 1, cursor.row));
      const col = Math.max(0, Math.min(w, cursor.col));
      out += '\x1b[' + (row + 1) + ';' + (col + 1) + 'H\x1b[?25h';
      process.stdout.write(out);
    }

    function filledRail(left, width, content) {
      const inner = Math.max(8, width - 2);
      const bar = fg(PINK, '│');
      return ' '.repeat(left) + bar + bgPad(BOX, ' ' + content, inner) + bar;
    }

    function roundEdge(left, width, which) {
      const inner = Math.max(8, width - 2);
      const body = '─'.repeat(inner);
      const s = which === 'top' ? '╭' + body + '╮' : '╰' + body + '╯';
      return ' '.repeat(left) + fg(BOX_EDGE, s);
    }

    function drawHome(w, h) {
      const lines = new Array(h).fill('');
      const logoW = visLen(LOGO[0]);
      const useLogo = w >= logoW + 4;
      const boxW = Math.max(40, Math.min(72, w - 8));
      const boxLeft = Math.max(0, Math.floor((w - boxW) / 2));
      const inputWidth = Math.max(12, boxW - 4);
      const typed = wrapText(state.input || '', inputWidth).slice(0, 3);
      const rows = [roundEdge(boxLeft, boxW, 'top'), filledRail(boxLeft, boxW, '')];
      if (state.input) {
        for (const row of typed) rows.push(filledRail(boxLeft, boxW, fg(FG, row)));
      } else {
        rows.push(
          filledRail(
            boxLeft,
            boxW,
            fg(MUTED, 'Ask anything...') + ' ' + fg(MUTED, '"What is the tech stack of this project?"')
          )
        );
      }
      rows.push(filledRail(boxLeft, boxW, ''));
      rows.push(filledRail(boxLeft, boxW, ''));
      rows.push(filledRail(boxLeft, boxW, fg(PINK, 'Agent') + fg(MUTED, ' · OLKIL')));
      rows.push(filledRail(boxLeft, boxW, ''));
      rows.push(roundEdge(boxLeft, boxW, 'bot'));

      const blockH = (useLogo ? LOGO.length : 1) + 2 + rows.length + 2;
      let y = Math.max(1, Math.floor((h - 2 - blockH) / 2));

      if (useLogo) {
        for (let i = 0; i < LOGO.length; i++) {
          lines[y++] = centerText(fg(LOGO_COLORS[i], LOGO[i]), w);
        }
      } else {
        lines[y++] = centerText(fg(PINK, 'OLKIL'), w);
      }
      lines[y++] = centerText(fg(MUTED, 'coding agent  ·  ask, edit, ship'), w);
      y += 1;

      const boxTop = y;
      for (const row of rows) {
        if (y >= h - 2) break;
        lines[y++] = row;
      }
      y += 1;
      if (y < h - 1) {
        lines[y] = centerText(
          fg(FG, 'tab') + fg(MUTED, ' agents     ') + fg(FG, 'ctrl+p') + fg(MUTED, ' commands'),
          w
        );
      }

      const folder = shortDir(meta.projectDir);
      const fl = '  ' + fg(PEACH, '●') + ' ' + fg(MUTED, folder);
      const fr = fg(MUTED, 'tab agents  ·  ctrl+p commands  ') + fg(PINK, 'OLKIL') + '  ';
      lines[h - 1] = fl + ' '.repeat(Math.max(1, w - visLen(fl) - visLen(fr))) + fr;

      const before = wrapText(state.input.slice(0, state.cursor), inputWidth);
      const curRowOff = state.input ? Math.max(0, before.length - 1) : 0;
      const curText = state.input ? before[before.length - 1] || '' : '';
      paint(lines, { row: boxTop + 2 + curRowOff, col: boxLeft + 2 + visLen(curText) }, w, h);
    }

    function drawChat(w, h) {
      const inputWidth = Math.max(16, w - 12);
      const typed = wrapText(state.input || '', inputWidth).slice(0, 3);
      const inputRows = state.input ? Math.max(1, typed.length) : 1;
      const askH = 1 + inputRows + 1;
      const bodyH = Math.max(4, h - 2 - askH - 1);
      const transcript = buildTranscript(w);
      const maxScroll = Math.max(0, transcript.length - bodyH);
      if (state.scroll > maxScroll) state.scroll = maxScroll;
      const start = Math.max(0, transcript.length - bodyH - state.scroll);
      const view = transcript.slice(start, start + bodyH);
      while (view.length < bodyH) view.push('');

      const left = fg(PINK, 'OLKIL') + fg(MUTED, '  ' + shortDir(meta.projectDir));
      const tokens = tokenLabel(meta);
      const right = fg(MUTED, meta.planName || '') + (tokens ? fg(FG, '  ' + tokens) + ' ' + fg(PINK, '●') : '');
      const gap = Math.max(1, w - visLen(left) - visLen(right) - 2);
      const lines = [];
      lines.push(' ' + left + ' '.repeat(gap) + right + ' ');
      lines.push(fg(LINE, '─'.repeat(w)));
      for (const row of view) lines.push('  ' + row);
      lines.push(fg(LINE, '─'.repeat(w)));
      const inputStartRow = lines.length;
      const ph = state.busy ? 'working…' : 'What should we change?';
      if (state.input) {
        lines.push('  ' + fg(PINK, 'ASK') + '  ' + fg(FG, typed[0] || ''));
        for (let i = 1; i < inputRows; i++) lines.push('       ' + fg(FG, typed[i] || ''));
      } else {
        lines.push('  ' + fg(PINK, 'ASK') + '  ' + fg(MUTED, ph));
      }
      lines.push(
        fg(MUTED, state.busy ? '  esc stop   ctrl+c quit' : '  enter send   /quit   ctrl+c quit')
      );

      const folder = shortDir(meta.projectDir);
      const fl = '  ' + fg(GREEN, '●') + ' ' + fg(MUTED, folder);
      const fr = fg(PINK, 'OLKIL') + '  ';
      lines.push(fl + ' '.repeat(Math.max(1, w - visLen(fl) - visLen(fr))) + fr);

      const before = wrapText(state.input.slice(0, state.cursor), inputWidth);
      const curRowOff = state.input ? Math.max(0, before.length - 1) : 0;
      const curText = state.input ? before[before.length - 1] || '' : '';
      paint(lines, { row: inputStartRow + curRowOff, col: 7 + visLen(curText) }, w, h);
    }

    function draw() {
      if (exiting) return;
      const w = cols();
      const h = rows();
      if (!state.messages.length) drawHome(w, h);
      else drawChat(w, h);
    }

    function finishLive(err) {
      const live = liveMsg();
      if (live) {
        live.live = false;
        if (err) live.error = brandText(err);
        for (const t of live.tools || []) t.done = true;
      }
      state.busy = false;
      state.status = 'ready';
      if (spinner) {
        clearInterval(spinner);
        spinner = null;
      }
    }

    async function settleTurn(err) {
      finishLive(err);
      try {
        if (!err && state.sessionId) {
          if (!state.usage) {
            const info = await api.request('GET', '/session/' + state.sessionId, { directory: meta.projectDir });
            const tok = info && (info.tokens || (info.data && info.data.tokens));
            if (tok) state.usage = parseUsage(tok);
          }
          if (state.usage && meta.session) {
            const billed = await chargeUsage(meta.session, state.usage);
            const sub = billed && (billed.subscription || billed);
            if (sub && (sub.spendable_left != null || sub.tokens_left != null || sub.plan_name || sub.plan)) {
              meta.planName = sub.plan_name || sub.plan || meta.planName;
              meta.leftLabel = sub.spendable_left_label || sub.tokens_left_label || meta.leftLabel;
              meta.spendable = Number(sub.spendable_left || sub.tokens_left || meta.spendable || 0);
            } else {
              const quota = await fetchQuota(meta.session);
              const qsub = quota.subscription || quota;
              meta.planName = qsub.plan_name || qsub.plan || meta.planName;
              meta.leftLabel = qsub.spendable_left_label || qsub.tokens_left_label || meta.leftLabel;
              meta.spendable = Number(qsub.spendable_left || qsub.tokens_left || 0);
            }
          }
        }
      } catch {
        /* ignore */
      }
      state.usage = null;
      scheduleDraw();
    }

    function ensureLive() {
      let live = liveMsg();
      if (!live) {
        live = { role: 'assistant', text: '', tools: [], live: true };
        state.messages.push(live);
      }
      return live;
    }

    function upsertTool(part) {
      const label = toolLabel(part);
      if (!label) return;
      const live = ensureLive();
      const id = String((part && (part.callID || part.id)) || label);
      let row = live.tools.find((t) => t.id === id);
      if (!row) {
        row = { id, label, done: false };
        live.tools.push(row);
      }
      row.label = label;
      const status = part.state && part.state.status;
      row.done = status === 'completed' || status === 'error';
      state.status = row.done ? 'writing' : label;
    }

    async function replyPermission(event) {
      const permission = event.properties || {};
      const id = permissionIdOf(permission);
      if (!id || !state.sessionId) return;
      const kind = String(permission.permission || permission.type || permission.tool || '').toLowerCase();
      const response = /external/.test(kind) ? 'reject' : 'always';
      try {
        await api.request('POST', '/session/' + state.sessionId + '/permissions/' + id, {
          directory: meta.projectDir,
        }, { response });
      } catch {
        /* ignore */
      }
    }

    function handleEvent(event) {
      if (!event || typeof event !== 'object') return;
      const sid = sessionIdOf(event);
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = (event.properties && event.properties.info) || event.properties || {};
        const id = String(info.id || '');
        const parent = String(info.parentID || info.parentId || '');
        if (id && parent && (parent === state.sessionId || state.childIds.has(parent))) state.childIds.add(id);
      }
      const ours = !sid || sid === state.sessionId || state.childIds.has(sid);
      if (!ours && event.type !== 'permission.asked') return;

      switch (event.type) {
        case 'message.updated': {
          const info = event.properties && event.properties.info;
          if (info && info.role === 'user' && info.id) state.userMessageIds.add(String(info.id));
          break;
        }
        case 'message.part.updated': {
          const part = event.properties && event.properties.part;
          if (!part) break;
          if (part.type === 'text' && typeof part.text === 'string' && !part.synthetic) {
            if (state.userMessageIds.has(String(part.messageID || ''))) break;
            const live = ensureLive();
            live.text = part.text;
            state.status = 'writing';
            scheduleDraw();
          } else if (part.type === 'tool') {
            upsertTool(part);
            scheduleDraw();
          } else if (part.type === 'reasoning' && typeof part.text === 'string') {
            state.status = 'planning';
            scheduleDraw();
          } else if (part.type === 'step-finish' || part.type === 'step_finish') {
            state.usage = addUsage(state.usage, parseUsage(part.tokens || part.usage));
          }
          break;
        }
        case 'permission.asked':
          replyPermission(event);
          break;
        case 'session.status': {
          const status = event.properties && event.properties.status;
          if (status && status.type === 'busy') state.status = state.status || 'working';
          if (status && status.type === 'retry') state.status = 'retrying';
          scheduleDraw();
          break;
        }
        case 'session.error': {
          const msg = errorMessage(event.properties && event.properties.error);
          if (msg && !/abort/i.test(msg)) void settleTurn(msg);
          break;
        }
        case 'session.idle': {
          if (sid && sid !== state.sessionId) break;
          void settleTurn();
          break;
        }
        default:
          break;
      }
    }

    async function ensureEngineSession() {
      if (state.sessionId) return state.sessionId;
      const created = await api.request('POST', '/session', { directory: meta.projectDir }, { title: 'OLKIL' });
      const id = created && (created.id || (created.data && created.data.id));
      if (!id) throw new Error('Could not start a chat session.');
      state.sessionId = String(id);
      return state.sessionId;
    }

    async function sendPrompt(text) {
      state.usage = null;
      const sid = await ensureEngineSession();
      const first = state.messages.filter((m) => m.role === 'user').length <= 1;
      const wrapped = first
        ? [
            'Workspace: ' + meta.projectDir + '. Stay inside this folder.',
            'You are OLKIL, the OLKIL coding agent. Never say you are OpenCode, Cursor, Cline, ChatGPT, or Claude.',
            text,
          ].join('\n\n')
        : text;
      const body = {
        agent: 'build',
        model,
        parts: [{ type: 'text', text: wrapped }],
      };
      try {
        await api.request('POST', '/session/' + sid + '/prompt_async', { directory: meta.projectDir }, body);
      } catch (err) {
        try {
          await api.request('POST', '/session/' + sid + '/prompt', { directory: meta.projectDir }, body);
        } catch (err2) {
          void settleTurn((err2 && err2.message) || (err && err.message) || 'Prompt failed');
        }
      }
    }

    async function abortRun() {
      if (!state.busy || !state.sessionId) return;
      try {
        await api.request('POST', '/session/' + state.sessionId + '/abort', { directory: meta.projectDir });
      } catch {
        /* ignore */
      }
      void settleTurn();
    }

    async function onSubmit(raw) {
      const text = String(raw || '').trim();
      if (!text) return;
      if (text === '/quit' || text === '/exit') return quit(0);
      if (text === '/clear') {
        state.messages = [];
        scheduleDraw();
        return;
      }
      if (text === '/help') {
        state.messages.push({
          role: 'system',
          text: 'enter send · esc stop · /clear · /quit',
        });
        scheduleDraw();
        return;
      }
      state.history.push(text);
      state.histIdx = -1;
      state.draft = '';
      state.messages.push({ role: 'user', text });
      state.messages.push({ role: 'assistant', text: '', tools: [], live: true });
      state.busy = true;
      state.status = 'working';
      state.scroll = 0;
      if (!spinner) {
        spinner = setInterval(() => {
          state.tick += 1;
          if (state.busy) scheduleDraw();
        }, 160);
      }
      scheduleDraw();
      try {
        await sendPrompt(text);
      } catch (err) {
        void settleTurn(err && err.message ? err.message : String(err));
      }
    }

    function insertText(chunk) {
      const left = state.input.slice(0, state.cursor);
      const right = state.input.slice(state.cursor);
      state.input = left + chunk + right;
      state.cursor += chunk.length;
    }

    function handleKey(buf) {
      const s = String(buf);
      if (s === '\u0003') return quit(0);
      if (s === '\u000c') {
        scheduleDraw();
        return;
      }
      if (s === '\u001b') {
        if (state.busy) abortRun();
        return;
      }
      if (s === '\r' || s === '\n') {
        if (state.busy) return;
        const text = state.input;
        state.input = '';
        state.cursor = 0;
        onSubmit(text);
        return;
      }
      if (s === '\u007f' || s === '\b') {
        if (state.cursor > 0) {
          state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
          state.cursor -= 1;
          scheduleDraw();
        }
        return;
      }
      if (s === '\u0015') {
        state.input = '';
        state.cursor = 0;
        scheduleDraw();
        return;
      }
      if (s.startsWith('\u001b[')) {
        if (s === '\u001b[A') {
          if (!state.history.length) return;
          if (state.histIdx < 0) {
            state.draft = state.input;
            state.histIdx = state.history.length - 1;
          } else if (state.histIdx > 0) state.histIdx -= 1;
          state.input = state.history[state.histIdx] || '';
          state.cursor = state.input.length;
          scheduleDraw();
          return;
        }
        if (s === '\u001b[B') {
          if (state.histIdx < 0) return;
          state.histIdx += 1;
          if (state.histIdx >= state.history.length) {
            state.histIdx = -1;
            state.input = state.draft;
          } else state.input = state.history[state.histIdx] || '';
          state.cursor = state.input.length;
          scheduleDraw();
          return;
        }
        if (s === '\u001b[C') {
          if (state.cursor < state.input.length) state.cursor += 1;
          scheduleDraw();
          return;
        }
        if (s === '\u001b[D') {
          if (state.cursor > 0) state.cursor -= 1;
          scheduleDraw();
          return;
        }
        if (s === '\u001b[3~') {
          state.input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1);
          scheduleDraw();
          return;
        }
        if (s === '\u001b[5~') {
          state.scroll += 8;
          scheduleDraw();
          return;
        }
        if (s === '\u001b[6~') {
          state.scroll = Math.max(0, state.scroll - 8);
          scheduleDraw();
          return;
        }
        return;
      }
      if (s && !/[\x00-\x1f]/.test(s)) {
        insertText(s);
        scheduleDraw();
      }
    }

    function quit(code) {
      if (exiting) return;
      exiting = true;
      if (spinner) clearInterval(spinner);
      if (drawTimer) clearTimeout(drawTimer);
      try {
        stopEvents();
      } catch {
        /* ignore */
      }
      try {
        process.stdin.removeListener('data', onStdin);
      } catch {
        /* ignore */
      }
      try {
        process.stdout.removeListener('resize', scheduleDraw);
      } catch {
        /* ignore */
      }
      restoreTerminal();
      resolve(code || 0);
    }

    function onStdin(chunk) {
      handleKey(chunk);
    }

    process.stdout.write('\x1b[?1049h\x1b]0;OLKIL\x07');
    try {
      process.stdin.setRawMode && process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onStdin);
    process.stdout.on('resize', scheduleDraw);
    stopEvents = startEventStream(api.url, api.authHeader, handleEvent);
    draw();
    process.once('SIGINT', () => quit(0));
    process.once('SIGTERM', () => quit(0));
  });
}

async function runAgent(projectDir) {
  banner();
  scrubGlobalOpencode();
  const session = await ensureSession();
  const email = (session.user && session.user.email) || '';
  if (email) log(c.dim + email + c.reset);
  let quota = {};
  try {
    quota = await fetchQuota(session);
  } catch (err) {
    fail('Could not verify your plan. Check the network and try again.');
    if (err && err.message) log(c.dim + '  ' + err.message + c.reset);
    process.exit(1);
  }
  const gated = assertCloudPlan(quota);
  ok('Plan: ' + gated.planName);
  if (gated.leftLabel) {
    log(c.dim + '  Tokens left: ' + gated.leftLabel + (gated.totalLabel ? ' / ' + gated.totalLabel : '') + c.reset);
  }

  const trusted = await askTrust(projectDir);
  if (!trusted) {
    log('Quit.');
    process.exit(0);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('OLKIL chat needs an interactive terminal.');
    process.exit(1);
  }

  const rawBin = await ensureOpencode();
  const engineKey = await hydrateEngineKey(session);
  writeOlkilRuntime();
  if (!engineKey && !resolveDeepseekKey()) {
    fail('OLKIL cloud model is not configured.');
    process.exit(1);
  }
  if (process.platform === 'win32') {
    try {
      process.title = 'OLKIL';
    } catch {
      /* ignore */
    }
  }
  log(c.dim + 'Starting OLKIL chat in ' + c.reset + c.magenta + projectDir + c.reset);

  let sidecar;
  try {
    sidecar = await startSidecar(rawBin);
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
    process.exit(1);
  }

  const api = {
    url: sidecar.url,
    authHeader: sidecar.authHeader,
    request(method, pathname, query, body) {
      return sidecarRequest(sidecar.url, sidecar.authHeader, method, pathname, query, body);
    },
  };

  let code = 0;
  try {
    code = await runOlkilChat(api, {
      projectDir,
      planName: gated.planName,
      leftLabel: gated.leftLabel,
      spendable: Number(gated.sub && (gated.sub.spendable_left || gated.sub.tokens_left) || 0),
      email,
      session,
    });
  } finally {
    stopChild(sidecar.proc);
    restoreTerminal();
  }
  process.exit(code || 0);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  scrubGlobalOpencode();
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    help();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    log(VERSION);
    return;
  }
  if (cmd === '--prepare') {
    writeOlkilRuntime();
    ok('engine files ready');
    return;
  }
  if (cmd === 'login') {
    banner();
    await completeLogin();
    await whoami();
    return;
  }
  if (cmd === 'logout') {
    clearSession();
    ok('Signed out.');
    return;
  }
  if (cmd === 'whoami') {
    banner();
    await whoami();
    return;
  }

  let projectDir = process.cwd();
  if (argv[0] && !String(argv[0]).startsWith('-')) {
    const maybe = path.resolve(argv[0]);
    if (fs.existsSync(maybe) && fs.statSync(maybe).isDirectory()) {
      projectDir = maybe;
    }
  }
  await runAgent(projectDir);
}

if (require.main === module) {
  main().catch((err) => {
    restoreTerminal();
    fail(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}
