/**
 * Stage secrets for packaged OLKIL:
 * 1) build/olkil.env  → electron-builder extraResources
 * 2) embedded-secrets.ts → webpack-bundled into the node process (reliable)
 *
 * Never commit build/olkil.env or embedded-secrets.ts.
 *
 * CI must pass DEEPSEEK_API_KEY / POOLSIDE_API_KEY / OPENROUTER_API_KEY as Actions secrets.
 * Local yarn start reads ide-electron/.env — packaged apps cannot.
 */
const fs = require('fs');
const path = require('path');

const ALLOWED = new Set([
  'POOLSIDE_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'OLKIL_MAX_TOKENS',
  'OLKIL_UPDATE_URL',
]);

const ALIASES = {
  DEEPSEEK_KEY: 'DEEPSEEK_API_KEY',
  DEEPSEEK_TOKEN: 'DEEPSEEK_API_KEY',
  POOLSIDE_KEY: 'POOLSIDE_API_KEY',
  OPENROUTER_KEY: 'OPENROUTER_API_KEY',
};

const root = path.join(__dirname, '..');
const src = path.join(root, '.env');
const destEnv = path.join(root, 'build', 'olkil.env');
const destTs = path.join(root, 'src', 'modules', 'olkil-ai', 'node', 'embedded-secrets.ts');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function usable(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/your_|changeme|placeholder|example/i.test(v)) return '';
  return v;
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function readPreviousEmbedded() {
  try {
    const text = fs.readFileSync(destTs, 'utf8');
    const grab = (name) => {
      const m = text.match(new RegExp(`export const ${name} = ("(?:\\\\.|[^"\\\\])*")`));
      return m ? usable(JSON.parse(m[1])) : '';
    };
    return {
      DEEPSEEK_API_KEY: grab('EMBEDDED_DEEPSEEK_API_KEY'),
      POOLSIDE_API_KEY: grab('EMBEDDED_POOLSIDE_API_KEY'),
      OPENROUTER_API_KEY: grab('EMBEDDED_OPENROUTER_API_KEY'),
    };
  } catch {
    return { DEEPSEEK_API_KEY: '', POOLSIDE_API_KEY: '', OPENROUTER_API_KEY: '' };
  }
}

function pick(merged, key) {
  return usable(merged[key]);
}

function main() {
  const parsed = fs.existsSync(src) ? parseEnv(fs.readFileSync(src, 'utf8')) : {};
  const merged = { ...parsed };
  for (const [key, val] of Object.entries(process.env)) {
    if (usable(val)) merged[key] = val;
  }
  for (const [from, to] of Object.entries(ALIASES)) {
    if (!usable(merged[to]) && usable(merged[from])) {
      merged[to] = merged[from];
    }
  }

  const previous = readPreviousEmbedded();
  const values = {};
  for (const key of ALLOWED) {
    const val = pick(merged, key);
    if (val) values[key] = val;
  }
  if (!values.DEEPSEEK_API_KEY && previous.DEEPSEEK_API_KEY) {
    values.DEEPSEEK_API_KEY = previous.DEEPSEEK_API_KEY;
  }
  if (!values.POOLSIDE_API_KEY && previous.POOLSIDE_API_KEY) {
    values.POOLSIDE_API_KEY = previous.POOLSIDE_API_KEY;
  }
  if (!values.OPENROUTER_API_KEY && previous.OPENROUTER_API_KEY) {
    values.OPENROUTER_API_KEY = previous.OPENROUTER_API_KEY;
  }

  const requireCloud =
    process.env.OLKIL_REQUIRE_CLOUD_KEYS === '1' || process.env.GITHUB_ACTIONS === 'true';
  const hasDeepseek = Boolean(values.DEEPSEEK_API_KEY);
  const hasPoolside = Boolean(values.POOLSIDE_API_KEY);
  const hasOpenRouter = Boolean(values.OPENROUTER_API_KEY);

  if (!hasPoolside) {
    console.warn('[stage-olkil-env] POOLSIDE_API_KEY missing — Dazzlone will fail.');
  }
  if (!hasDeepseek) {
    console.warn('[stage-olkil-env] DEEPSEEK_API_KEY missing — DeepSeek will 401 (governor).');
  }
  if (!hasOpenRouter) {
    console.warn('[stage-olkil-env] OPENROUTER_API_KEY missing — Auto / OpenRouter models will 401.');
  }
  if (requireCloud && !hasDeepseek) {
    console.error(
      '[stage-olkil-env] Refusing to pack without DEEPSEEK_API_KEY.\n' +
        'Add repo secret DEEPSEEK_API_KEY (same key as ide-electron/.env) and pass it into the build job.',
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(destTs), { recursive: true });
  if (!hasDeepseek && !hasPoolside && !hasOpenRouter) {
    fs.writeFileSync(
      destTs,
      `/** Auto-generated — do not commit. Run: node scripts/stage-olkil-env.js */\n` +
        `export const EMBEDDED_POOLSIDE_API_KEY = '';\n` +
        `export const EMBEDDED_DEEPSEEK_API_KEY = '';\n` +
        `export const EMBEDDED_OPENROUTER_API_KEY = '';\n` +
        `export const EMBEDDED_ENV: Record<string, string> = {};\n`,
      'utf8',
    );
    return false;
  }

  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.mkdirSync(path.dirname(destEnv), { recursive: true });
  fs.writeFileSync(destEnv, lines.join('\n') + '\n', 'utf8');
  console.log(
    '[stage-olkil-env] Wrote',
    destEnv,
    `(deepseek=${hasDeepseek ? 'yes' : 'NO'} poolside=${hasPoolside ? 'yes' : 'NO'} openrouter=${hasOpenRouter ? 'yes' : 'NO'})`,
  );

  const embeddedObj = Object.entries(values)
    .map(([k, v]) => `  ${jsString(k)}: ${jsString(v)},`)
    .join('\n');

  fs.writeFileSync(
    destTs,
    `/** Auto-generated by scripts/stage-olkil-env.js — do not commit. */\n` +
      `export const EMBEDDED_POOLSIDE_API_KEY = ${jsString(values.POOLSIDE_API_KEY || '')};\n` +
      `export const EMBEDDED_DEEPSEEK_API_KEY = ${jsString(values.DEEPSEEK_API_KEY || '')};\n` +
      `export const EMBEDDED_OPENROUTER_API_KEY = ${jsString(values.OPENROUTER_API_KEY || '')};\n` +
      `export const EMBEDDED_ENV: Record<string, string> = {\n${embeddedObj}\n};\n`,
    'utf8',
  );
  console.log('[stage-olkil-env] Wrote', destTs);
  return true;
}

main();
