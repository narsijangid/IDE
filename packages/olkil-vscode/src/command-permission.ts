/**
 * Decides which agent shell commands run on their own and which wait for the user.
 * Kept in sync with ide-electron/src/modules/olkil-ai/common/command-permission.ts.
 */

export type TerminalAutoRun = 'always' | 'allowlist' | 'never';

export interface CommandPolicy {
  autoRun: TerminalAutoRun;
  allowlist: string[];
  allowCommit?: boolean;
  allowPush?: boolean;
  allowPr?: boolean;
}

/** Why a command needs the user even when auto-run would allow it. */
export type CommandGate = '' | 'destructive' | 'gitCommit' | 'gitPush' | 'gitPr';

export interface CommandVerdict {
  decision: 'allow' | 'ask';
  gate: CommandGate;
  /** Allowlist entries that would let this command run next time. */
  prefixes: string[];
}

export const DEFAULT_COMMAND_ALLOWLIST: string[] = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git rev-parse',
  'ls',
  'dir',
  'pwd',
  'cd',
  'echo',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'tree',
  'rg',
  'grep',
  'findstr',
  'where',
  'which',
  'Get-ChildItem',
  'Get-Content',
  'Get-Location',
  'Test-Path',
  'Select-String',
  'Select-Object',
  'Sort-Object',
  'Measure-Object',
  'node -v',
  'node --version',
  'npm -v',
  'npm --version',
  'npm ls',
  'npm view',
  'npm test',
  'npm run test',
  'npm run lint',
  'yarn test',
  'pnpm test',
  'python --version',
  'tsc --noEmit',
  'npx tsc --noEmit',
];

const SUBCOMMAND_TOOLS = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'git', 'gh', 'glab', 'pip', 'pip3', 'python', 'python3', 'py', 'node',
  'docker', 'docker-compose', 'kubectl', 'cargo', 'go', 'dotnet', 'composer', 'php', 'bundle', 'rails', 'deno',
  'poetry', 'uv', 'make', 'brew', 'apt', 'apt-get', 'winget', 'choco', 'flutter', 'dart', 'mvn', 'gradle',
  'terraform', 'az', 'aws', 'gcloud', 'firebase', 'vercel', 'netlify', 'supabase', 'prisma', 'expo',
]);

const SCRIPT_RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);

const DESTRUCTIVE: RegExp[] = [
  /^(sudo\s+)?rm\s+(-[a-z]*[rf][a-z]*\s+|--(recursive|force)\b)/i,
  /^(rmdir|rd)\s+.*\/s\b/i,
  /^(del|erase)\s+.*\/[sqf]\b/i,
  /^remove-item\b.*-(recurse|force)\b/i,
  /^git\s+reset\s+--hard\b/i,
  /^git\s+clean\s+-[a-z]*f/i,
  /^git\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i,
  /^git\s+(branch\s+-D|checkout\s+--\s+\.|restore\s+\.)/i,
  /^(format|mkfs\S*|diskpart|shutdown|reboot|halt|poweroff)\b/i,
  /^(chmod|chown)\s+-R\b/i,
  /\bdrop\s+(database|table|schema)\b/i,
];

/** Downloads piped straight into a shell; checked on the whole line because pipes split segments. */
const PIPE_TO_SHELL =
  /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sh|bash|zsh|iex|invoke-expression|pwsh|powershell)\b/i;

function normalize(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Splits `a && b; c | d` into its commands, ignoring separators inside quotes. */
export function splitShellCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  const src = String(command || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((part) => part.trim()).filter(Boolean);
}

function stripQuoted(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** Command substitution or writing to a file: never auto-run from the allowlist. */
function hasRiskySyntax(command: string): boolean {
  const bare = stripQuoted(command)
    .replace(/\d?>&\d/g, '')
    .replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, '');
  return /\$\(|`/.test(bare) || />/.test(bare);
}

function words(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || tokens[0] === 'sudo')) {
    tokens.shift();
  }
  if (tokens.length) {
    tokens[0] = tokens[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '');
  }
  return tokens;
}

/** The allowlist entry a user would add to stop being asked for this command. */
export function commandPrefix(segment: string): string {
  const tokens = words(segment);
  if (!tokens.length) return '';
  const tool = tokens[0];
  const lower = tool.toLowerCase();
  const sub = tokens[1];
  if (!SUBCOMMAND_TOOLS.has(lower) || !sub || sub.startsWith('-')) return tool;
  if (SCRIPT_RUNNERS.has(lower) && /^(run|exec|x|dlx)$/i.test(sub) && tokens[2] && !tokens[2].startsWith('-')) {
    return `${tool} ${sub} ${tokens[2]}`;
  }
  return `${tool} ${sub}`;
}

function matchesEntry(segment: string, entry: string): boolean {
  const seg = normalize(words(segment).join(' '));
  const want = normalize(entry);
  return Boolean(want) && (seg === want || seg.startsWith(want + ' '));
}

export function isAllowlisted(segment: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => matchesEntry(segment, entry));
}

function gateFor(segment: string, policy: CommandPolicy): CommandGate {
  const seg = normalize(words(segment).join(' '));
  if (DESTRUCTIVE.some((re) => re.test(seg))) return 'destructive';
  if (/^git push\b/.test(seg) && policy.allowPush === false) return 'gitPush';
  if (/^git commit\b/.test(seg) && policy.allowCommit === false) return 'gitCommit';
  if (/^(gh pr create|glab mr create)\b/.test(seg) && policy.allowPr === false) return 'gitPr';
  return '';
}

export function decideCommand(command: string, policy: CommandPolicy): CommandVerdict {
  const segments = splitShellCommand(command);
  const allowlist = policy.allowlist || [];
  const prefixes: string[] = [];
  for (const segment of segments) {
    if (isAllowlisted(segment, allowlist)) continue;
    const prefix = commandPrefix(segment);
    if (prefix && !prefixes.some((p) => normalize(p) === normalize(prefix))) prefixes.push(prefix);
  }
  if (!segments.length) return { decision: 'ask', gate: '', prefixes };
  if (PIPE_TO_SHELL.test(command)) return { decision: 'ask', gate: 'destructive', prefixes: [] };
  let gate: CommandGate = '';
  for (const segment of segments) {
    gate = gateFor(segment, policy);
    if (gate) return { decision: 'ask', gate, prefixes: gate === 'destructive' ? [] : prefixes };
  }
  if (policy.autoRun === 'always') return { decision: 'allow', gate, prefixes };
  if (policy.autoRun === 'never' || hasRiskySyntax(command)) return { decision: 'ask', gate, prefixes };
  return { decision: segments.every((s) => isAllowlisted(s, allowlist)) ? 'allow' : 'ask', gate, prefixes };
}

/** Adds entries to an allowlist without duplicates (case-insensitive). */
export function mergeAllowlist(list: string[], add: string[]): string[] {
  const out = [...list];
  for (const entry of add) {
    const clean = String(entry || '').trim();
    if (clean && !out.some((e) => normalize(e) === normalize(clean))) out.push(clean);
  }
  return out;
}
