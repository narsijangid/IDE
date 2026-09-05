#!/usr/bin/env node
'use strict';

/**
 * OLKIL CLI — Google login, plan check, then OpenCode in the project folder.
 * Branding is OLKIL. The agent runtime is OpenCode.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

const VERSION = '1.0.14';
const OPENCODE_VERSION = process.env.OPENCODE_VERSION || 'v1.18.21';
const ORIGIN = (process.env.OLKIL_AUTH_ORIGIN || 'https://olkil.com').replace(/\/$/, '');
const FIREBASE_API_KEY = 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k';
const HOME = path.join(os.homedir(), '.olkil');
const SESSION_FILE = path.join(HOME, 'auth-session.json');
const TRUST_FILE = path.join(HOME, 'trusted-workspaces.json');
const BIN_DIR = path.join(HOME, 'opencode-bin');
const OPENCODE_EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
const OPENCODE_HOME_DIR = path.join(HOME, 'opencode-home');
const TUI_CONFIG_FILE = path.join(OPENCODE_HOME_DIR, 'tui.json');
const BRAND_PLUGIN_FILE = path.join(OPENCODE_HOME_DIR, 'plugins', 'olkil-brand.tsx');
const THEME_FILE = path.join(OPENCODE_HOME_DIR, 'themes', 'olkil.json');
const IDENTITY_FILE = path.join(OPENCODE_HOME_DIR, 'AGENTS.md');
const BRAND_MARK = 'v6-icon-loader';

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
  log('  olkil              Sign in, trust this folder, start the agent');
  log('  olkil .            Use the current directory');
  log('  olkil <path>       Use a project folder');
  log('  olkil login        Google sign-in in the browser');
  log('  olkil logout       Clear the saved session');
  log('  olkil whoami       Show account and plan');
  log('  olkil --help       This help');
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

const OLKIL_TUI_PLUGIN = `/** @jsxImportSource @opentui/solid */

const ROWS = [
  " ██████╗ ██╗     ██╗  ██╗██╗██╗     ",
  "██╔═══██╗██║     ██║ ██╔╝██║██║     ",
  "██║   ██║██║     █████╔╝ ██║██║     ",
  "██║   ██║██║     ██╔═██╗ ██║██║     ",
  "╚██████╔╝███████╗██║  ██╗██║███████╗",
  " ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝",
]

function cleanBrand(value) {
  const s = String(value || "")
    .replace(/opencode/gi, "OLKIL")
    .replace(/big[\\s-]*pickle/gi, "OLKIL")
    .replace(/\\balkil\\b/gi, "OLKIL")
    .replace(/anomalyco/gi, "OLKIL")
    .replace(/\\s{2,}/g, " ")
    .trim()
  if (!s) return "Chat"
  if (/are you OLKIL/i.test(s) && /using OLKIL/i.test(s)) return "Chat"
  if (/^OLKIL$/i.test(s)) return "Chat"
  return s
}

function shortDir(api) {
  try {
    const dir = String((api.state && api.state.path && api.state.path.directory) || "")
    const parts = dir.replace(/\\\\/g, "/").split("/").filter(Boolean)
    return parts.slice(-2).join("/") || "workspace"
  } catch {
    return "workspace"
  }
}

function setTitle(api) {
  try {
    if (api.renderer && typeof api.renderer.setTerminalTitle === "function") {
      api.renderer.setTerminalTitle("OLKIL")
    }
  } catch {}
}

const tui = async (api) => {
  const muted = "#71717A"
  const peach = "#FFC09A"
  const pink = "#FF2D8C"
  try {
    if (api.kv && typeof api.kv.set === "function") {
      api.kv.set("dismissed_getting_started", true)
      api.kv.set("tips_hidden", true)
    }
  } catch {}
  try {
    if (api.theme && typeof api.theme.set === "function") api.theme.set("olkil")
  } catch {}
  try {
    if (api.plugins && typeof api.plugins.deactivate === "function") {
      await api.plugins.deactivate("internal:sidebar-footer")
      await api.plugins.deactivate("internal:home-footer")
      await api.plugins.deactivate("internal:home-tips")
    }
  } catch {}
  setTitle(api)
  try {
    if (api.event && typeof api.event.on === "function") {
      api.event.on("session.created", () => setTitle(api))
      api.event.on("session.idle", () => setTitle(api))
    }
  } catch {}

  api.slots.register({
    order: 5000,
    slots: {
      home_logo() {
        return (
          <box flexDirection="column" alignItems="center" gap={1}>
            <box flexDirection="column" alignItems="center">
              <text fg={peach}>{ROWS[0]}</text>
              <text fg={pink}>{ROWS[1]}</text>
              <text fg="#FF4DA6">{ROWS[2]}</text>
              <text fg="#FFFFFF">{ROWS[3]}</text>
              <text fg="#D4D4D8">{ROWS[4]}</text>
              <text fg={muted}>{ROWS[5]}</text>
            </box>
            <text fg={muted}>coding agent  ·  ask, edit, ship</text>
          </box>
        )
      },
      home_footer() {
        return (
          <box width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="row" justifyContent="space-between">
            <box flexDirection="row" gap={1}>
              <text fg={peach}>●</text>
              <text fg={muted}>{shortDir(api)}</text>
            </box>
            <text fg={muted}>tab agents  ·  ctrl+p commands</text>
            <text fg={pink}>OLKIL</text>
          </box>
        )
      },
      sidebar_title(ctx, props) {
        const data = props && props.title !== undefined ? props : ctx
        const title = cleanBrand(data && data.title)
        return (
          <box gap={1} paddingBottom={1}>
            <text fg={pink}>OLKIL</text>
            <text fg={muted}>{title}</text>
            <text fg={pink}>──────────</text>
          </box>
        )
      },
      sidebar_footer() {
        return (
          <box gap={1}>
            <text fg={muted}>{shortDir(api)}</text>
            <box flexDirection="row" gap={1}>
              <text fg={peach}>●</text>
              <text fg={pink}>OLKIL</text>
              <text fg={muted}>${VERSION}</text>
            </box>
          </box>
        )
      },
    },
  })
}

export default {
  id: "olkil-brand-v6",
  tui,
}
`;

function pluginPathForConfig(file) {
  return file.replace(/\\/g, '/');
}

const OLKIL_THEME = {
  $schema: 'https://opencode.ai/theme.json',
  defs: {
    bg: '#050506',
    panel: '#111114',
    element: '#18181c',
    border: '#27272a',
    muted: '#71717a',
    fg: '#f4f4f5',
    peach: '#FFC09A',
    pink: '#FF2D8C',
    pinkHot: '#FF4DA6',
  },
  theme: {
    primary: 'pink',
    secondary: 'pinkHot',
    accent: 'pink',
    error: '#ff6767',
    warning: 'peach',
    success: '#61ffca',
    info: 'pink',
    text: 'fg',
    textMuted: 'muted',
    background: 'bg',
    backgroundPanel: 'panel',
    backgroundElement: 'element',
    border: 'border',
    borderActive: 'pink',
    borderSubtle: 'border',
    diffAdded: '#61ffca',
    diffRemoved: '#ff6767',
    diffContext: 'muted',
    diffHunkHeader: 'muted',
    diffHighlightAdded: '#61ffca',
    diffHighlightRemoved: '#ff6767',
    diffAddedBg: '#162620',
    diffRemovedBg: '#3f191a',
    diffContextBg: 'panel',
    diffLineNumber: 'muted',
    diffAddedLineNumberBg: '#162620',
    diffRemovedLineNumberBg: '#26161a',
    markdownText: 'fg',
    markdownHeading: 'pink',
    markdownLink: 'pinkHot',
    markdownLinkText: 'pink',
    markdownCode: '#FFC09A',
    markdownBlockQuote: 'muted',
    markdownEmph: '#FFC09A',
    markdownStrong: 'pinkHot',
    markdownHorizontalRule: 'muted',
    markdownListItem: 'pink',
    markdownListEnumeration: 'pinkHot',
    markdownImage: 'pinkHot',
    markdownImageText: 'pink',
    markdownCodeBlock: 'fg',
    syntaxComment: 'muted',
    syntaxKeyword: 'pinkHot',
    syntaxFunction: 'pink',
    syntaxVariable: 'pink',
    syntaxString: '#61ffca',
    syntaxNumber: '#9dff65',
    syntaxType: 'pinkHot',
    syntaxOperator: 'pink',
    syntaxPunctuation: 'fg',
  },
};

function olkilOpencodeConfig(pluginSpec) {
  return {
    $schema: 'https://opencode.ai/config.json',
    username: 'OLKIL',
    autoupdate: false,
    share: 'disabled',
    plugin: [pluginSpec],
    instructions: [pluginPathForConfig(IDENTITY_FILE)],
    agent: {
      build: { color: '#FF2D8C' },
      plan: { color: '#FF4DA6' },
      general: { color: '#FF2D8C' },
    },
    provider: {
      opencode: {
        name: 'OLKIL',
        models: {
          'big-pickle': {
            name: 'OLKIL',
          },
        },
      },
    },
  };
}

function writeOlkilRuntime() {
  mkdirp(path.dirname(BRAND_PLUGIN_FILE));
  mkdirp(path.dirname(THEME_FILE));
  fs.writeFileSync(BRAND_PLUGIN_FILE, OLKIL_TUI_PLUGIN);
  fs.writeFileSync(IDENTITY_FILE, OLKIL_IDENTITY);
  writeJson(THEME_FILE, OLKIL_THEME);
  const fallbackAgents = path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
  if (fallbackAgents !== IDENTITY_FILE) {
    mkdirp(path.dirname(fallbackAgents));
    fs.writeFileSync(fallbackAgents, OLKIL_IDENTITY);
  }
  const pluginSpec = pluginPathForConfig(BRAND_PLUGIN_FILE);
  writeJson(TUI_CONFIG_FILE, {
    $schema: 'https://opencode.ai/tui.json',
    theme: 'olkil',
    plugin: [pluginSpec],
    logo: { animate: true, sound: false },
  });
  writeJson(path.join(OPENCODE_HOME_DIR, 'opencode.json'), olkilOpencodeConfig(pluginSpec));
  const fallbackTheme = path.join(os.homedir(), '.config', 'opencode', 'themes', 'olkil.json');
  if (fallbackTheme !== THEME_FILE) {
    mkdirp(path.dirname(fallbackTheme));
    writeJson(fallbackTheme, OLKIL_THEME);
  }
}

function brandSwap(from, to) {
  const a = Buffer.from(from, 'utf8');
  const b = Buffer.from(to, 'utf8');
  if (b.length > a.length) return null;
  return [a, Buffer.concat([b, Buffer.alloc(a.length - b.length, 0x20)])];
}

function brandOpencodeBinary(binPath, force) {
  if (!binPath || !fs.existsSync(binPath)) return binPath;
  const branded = path.join(path.dirname(binPath), process.platform === 'win32' ? 'olkil-runtime.exe' : 'olkil-runtime');
  const marker = branded + '.ok';
  try {
    if (
      !force &&
      fs.existsSync(branded) &&
      fs.existsSync(marker) &&
      fs.readFileSync(marker, 'utf8').trim() === BRAND_MARK &&
      fs.statSync(branded).size > 5 * 1024 * 1024
    ) {
      return branded;
    }
  } catch {
    if (!force && fs.existsSync(branded)) return branded;
  }

  try {
    const buf = Buffer.from(fs.readFileSync(binPath));
    const swaps = [
      brandSwap('setTerminalTitle("OpenCode")', 'setTerminalTitle("OLKIL")'),
      brandSwap('Title("OpenCode")', 'Title("OLKIL")'),
      brandSwap('OC | ${z}', 'OLKIL${z}'),
      brandSwap('OC | ${b.data.id}', 'OLKIL${b.data.id}'),
      brandSwap('You are OpenCode', 'You are OLKIL'),
      brandSwap('name:"Big Pickle"', 'name:"OLKIL Core"'),
      brandSwap('Big Pickle', 'OLKIL Core'),
      brandSwap('OpenCode ({{version}})', 'OLKIL ({{version}})'),
      brandSwap('Uninstall OpenCode', 'Uninstall OLKIL'),
      brandSwap('\\u25A3 ', '»»'),
      brandSwap(
        'qn({color:gU,style:"blocks",inactiveFactor:0.6,minAlpha:0.3}),color:Fn({color:gU,style:"blocks",inactiveFactor:0.6,minAlpha:0.3})',
        '["🟢🔵🟡🔴","🔴🟢🔵🟡","🟡🔴🟢🔵","🔵🟡🔴🟢"],color:void 0',
      ),
      brandSwap(
        '$0({color:l().highlight,style:"blocks",inactiveFactor:0.6,minAlpha:0.3}),color:p0({color:l().highlight,style:"blocks",inactiveFactor:0.6,minAlpha:0.3})',
        '["🟢🔵🟡🔴","🔴🟢🔵🟡","🟡🔴🟢🔵","🔵🟡🔴🟢"],color:void 0',
      ),
      brandSwap(
        'OpenCode includes free models so you can start immediately.',
        'OLKIL includes cloud models so you can start immediately.',
      ),
      brandSwap(
        'When the user directly asks about OpenCode (eg. "can OpenCode do...", "does OpenCode have..."), or asks in second person (eg. "are you able...", "can you do..."), or asks how to use a specific OpenCode feature (eg. implement a hook, write a slash command, or install an MCP server), use the WebFetch tool to gather information to answer the question from OpenCode docs. The list of available docs is available at https://opencode.ai/docs',
        'If the user asks who you are, you are OLKIL, the OLKIL coding agent. Do not name any other product. Do not use WebFetch for identity. Answer as OLKIL, then help with software engineering tasks.',
      ),
      brandSwap(
        "When the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the WebFetch tool to gather information to answer the question from opencode docs at https://opencode.ai",
        'If asked who you are, you are OLKIL. Do not name any other product. Do not fetch outside docs for identity. Help with coding in the terminal.',
      ),
      brandSwap(
        '- When users ask directly about OpenCode (eg. "can OpenCode do...", "are you able to do...") or its features (eg. implement a hook, write a slash command, or install an MCP server), use the WebFetch tool to gather information to answer the question from the OpenCode docs at https://opencode.ai/docs.',
        '- If asked who you are, you are OLKIL, the OLKIL coding agent. Do not name any other product. Do not use WebFetch for identity.',
      ),
    ].filter(Boolean);
    for (const [from, to] of swaps) {
      if (!from || !to || from.length !== to.length) continue;
      let idx = 0;
      while ((idx = buf.indexOf(from, idx)) !== -1) {
        to.copy(buf, idx);
        idx += to.length;
      }
    }
    const tmp = branded + '.tmp';
    fs.writeFileSync(tmp, buf);
    try {
      fs.unlinkSync(branded);
    } catch {
      /* first run or locked previous copy */
    }
    try {
      fs.renameSync(tmp, branded);
    } catch {
      fs.copyFileSync(tmp, branded);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    if (process.platform !== 'win32') fs.chmodSync(branded, 0o755);
    fs.writeFileSync(marker, BRAND_MARK);
    return branded;
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      return fs.existsSync(branded) ? branded : binPath;
    }
    if (err && err.message) warn('Branding skipped: ' + err.message);
    return fs.existsSync(branded) ? branded : binPath;
  }
}

function olkilRuntimeEnv() {
  const pluginSpec = pluginPathForConfig(BRAND_PLUGIN_FILE);
  return {
    OPENCODE_CALLER: 'olkil',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_TERMINAL_TITLE: '1',
    OPENCODE_HOME: OPENCODE_HOME_DIR,
    OPENCODE_CONFIG_DIR: OPENCODE_HOME_DIR,
    OPENCODE_TUI_CONFIG: TUI_CONFIG_FILE,
    COLORTERM: 'truecolor',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(olkilOpencodeConfig(pluginSpec)),
  };
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
  const envBin = process.env.OLKIL_OPENCODE_BIN || process.env.OPENCODE_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const cached = path.join(BIN_DIR, OPENCODE_EXE);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 5 * 1024 * 1024) return cached;
  mkdirp(BIN_DIR);
  const name = opencodeAsset();
  const url = 'https://github.com/anomalyco/opencode/releases/download/' + OPENCODE_VERSION + '/' + name;
  const tmp = path.join(os.tmpdir(), 'olkil-' + name);
  const extract = path.join(BIN_DIR, '.extract');
  log(c.dim + 'Downloading agent runtime…' + c.reset);
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
  if (!found) throw new Error('Agent runtime missing from archive');
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
          } catch (err) {
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
  ok('Login successful!');
  log(c.dim + 'Authentication tokens stored securely.' + c.reset);
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
    log(c.yellow + '  ┌──────────────────────────────────────────────────────────┐' + c.reset);
    log(c.yellow + '  │  Workspace Trust Required                                │' + c.reset);
    log(c.yellow + '  │                                                          │' + c.reset);
    log(c.yellow + '  │' + c.reset + '  OLKIL can edit files and run commands in this folder.   ' + c.yellow + '│' + c.reset);
    log(c.yellow + '  │' + c.reset + '  Do you trust the contents of this directory?            ' + c.yellow + '│' + c.reset);
    log(c.yellow + '  │                                                          │' + c.reset);
    log(c.yellow + '  │  ' + c.reset + c.cyan + dir + c.reset);
    log(c.yellow + '  │                                                          │' + c.reset);
    log(c.yellow + '  │  [a] Trust this workspace     [q] Quit                   │' + c.reset);
    log(c.yellow + '  └──────────────────────────────────────────────────────────┘' + c.reset);
    log(c.dim + '  Press a to continue, q to quit' + c.reset);
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
    denyPlan('No tokens left on ' + planName + '.', [
      planName + (totalLabel ? ' includes ' + totalLabel + ' tokens per period.' : ' token allowance is used up.'),
      'Buy ' + planName + ' again for a fresh 30-day window, or upgrade:',
      'Lite $3 · 100M   Pro $10 · 350M   Ultra $49 · 2B',
    ], url);
  }

  if (reason === 'expired') {
    denyPlan('Your paid plan has expired.', [
      'You are back on Dazzlone (free). The CLI needs Lite, Pro, or Ultra.',
      'Renew at olkil.com/pricing.',
    ], url);
  }

  denyPlan('Please upgrade to Lite, Pro, or Ultra.', [
    'Signed in as a free Dazzlone account. Cloud agents are not included.',
    'Lite  $3   ·  100M tokens / month',
    'Pro   $10  ·  350M tokens / month',
    'Ultra $49  ·  2B tokens / month',
    ], url);
}

async function whoami() {
  const session = await ensureSession();
  const quota = await fetchQuota(session);
  const sub = quota.subscription || quota;
  log((session.user && session.user.email) || 'signed in');
  log('Plan: ' + (sub.plan_name || sub.plan || 'Dazzlone'));
  if (sub.tokens_left_label) log('Tokens left: ' + sub.tokens_left_label + (sub.tokens_total_label ? ' / ' + sub.tokens_total_label : ''));
  if (quota.allowed !== true) {
    log(c.yellow + (quota.message || 'Upgrade to Lite, Pro, or Ultra to use the CLI.') + c.reset);
    if (quota.upgrade_url || sub.upgrade_url) log(c.dim + (sub.upgrade_url || quota.upgrade_url) + c.reset);
  }
}

async function runAgent(projectDir, extraArgs) {
  banner();
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

  const rawBin = await ensureOpencode();
  writeOlkilRuntime();
  const bin = brandOpencodeBinary(rawBin);
  if (process.platform === 'win32') {
    try {
      process.title = 'OLKIL';
    } catch {
      /* ignore */
    }
  }
  log('');
  log(c.dim + 'Starting OLKIL in ' + c.reset + c.magenta + projectDir + c.reset);
  log(c.dim + 'Type a task. The agent stays branded as OLKIL.' + c.reset);
  log('');
  try {
    process.stdout.write('\x1b]0;OLKIL\x07');
  } catch {
    /* ignore */
  }

  const child = spawn(bin, extraArgs, {
    cwd: projectDir,
    stdio: 'inherit',
    env: Object.assign({}, process.env, olkilRuntimeEnv()),
  });
  child.on('exit', (code) => process.exit(code || 0));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    help();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    log(VERSION);
    return;
  }
  if (cmd === 'rebrand' || cmd === '--rebrand') {
    banner();
    writeOlkilRuntime();
    const rawBin = path.join(BIN_DIR, OPENCODE_EXE);
    const bin = brandOpencodeBinary(rawBin, true);
    ok('UI brand files written');
    ok('Runtime: ' + bin);
    log(c.dim + 'Close every OLKIL window, then run: olkil' + c.reset);
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
  let extra = argv.slice();
  if (argv[0] && !String(argv[0]).startsWith('-')) {
    const maybe = path.resolve(argv[0]);
    if (fs.existsSync(maybe) && fs.statSync(maybe).isDirectory()) {
      projectDir = maybe;
      extra = argv.slice(1);
    }
  }
  await runAgent(projectDir, extra);
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
  process.exit(1);
});
