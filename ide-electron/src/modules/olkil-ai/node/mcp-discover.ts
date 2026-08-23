import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DiscoveredMcpServer {
  id: string;
  name: string;
  type: 'local' | 'remote';
  command?: string;
  url?: string;
  source: string;
  sourceKind: 'extension' | 'user' | 'workspace';
  hasAuth: boolean;
  /** Disabled in the source file */
  fileDisabled: boolean;
}

export interface RuntimeMcpServer {
  name: string;
  enabled: boolean;
  type: 'local' | 'remote';
  command?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface ParsedServer {
  name: string;
  type: 'local' | 'remote';
  command?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  fileDisabled: boolean;
  fromExtension: boolean;
}

/**
 * MCP servers installed via Cursor/VS Code/Hostinger extensions live in mcp.json
 * files on disk. Secrets stay in those files; the UI only gets names + source.
 */
export function listDiscoveredMcpServers(workspaceRoot?: string): DiscoveredMcpServer[] {
  const seen = new Set<string>();
  const out: DiscoveredMcpServer[] = [];
  for (const hit of collectParsed(workspaceRoot)) {
    const id = `${slug(hit.source)}:${hit.server.name}`;
    if (seen.has(id) || seen.has(hit.server.name)) {
      continue;
    }
    seen.add(id);
    seen.add(hit.server.name);
    out.push({
      id,
      name: hit.server.name,
      type: hit.server.type,
      command: hit.server.command,
      url: publicUrl(hit.server.url),
      source: hit.source,
      sourceKind: hit.server.fromExtension ? 'extension' : hit.kind,
      hasAuth: Boolean(
        (hit.server.env && Object.keys(hit.server.env).some((key) => isSecretKey(key))) ||
          (hit.server.headers && Object.keys(hit.server.headers).length),
      ),
      fileDisabled: hit.server.fileDisabled,
    });
  }
  return out;
}

export function loadRuntimeMcpServers(
  workspaceRoot: string | undefined,
  disabledIds: string[],
): RuntimeMcpServer[] {
  const disabled = new Set(disabledIds || []);
  const seen = new Set<string>();
  const out: RuntimeMcpServer[] = [];
  for (const hit of collectParsed(workspaceRoot)) {
    const id = `${slug(hit.source)}:${hit.server.name}`;
    if (seen.has(hit.server.name)) {
      continue;
    }
    seen.add(hit.server.name);
    if (hit.server.fileDisabled || disabled.has(id) || disabled.has(hit.server.name)) {
      continue;
    }
    out.push({
      name: hit.server.name,
      enabled: true,
      type: hit.server.type,
      command: hit.server.command,
      url: hit.server.url,
      env: hit.server.env,
      headers: hit.server.headers,
    });
  }
  return out;
}

function collectParsed(workspaceRoot?: string): Array<{
  source: string;
  kind: 'extension' | 'user' | 'workspace';
  server: ParsedServer;
}> {
  const hits: Array<{ source: string; kind: 'extension' | 'user' | 'workspace'; server: ParsedServer }> = [];
  for (const loc of discoveryLocations(workspaceRoot)) {
    const parsed = readMcpFile(loc.file);
    if (!parsed.length) {
      continue;
    }
    for (const server of parsed) {
      hits.push({ source: loc.source, kind: loc.kind, server });
    }
  }
  return hits;
}

function discoveryLocations(workspaceRoot?: string): Array<{
  file: string;
  source: string;
  kind: 'extension' | 'user' | 'workspace';
}> {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out: Array<{ file: string; source: string; kind: 'extension' | 'user' | 'workspace' }> = [];
  const add = (file: string, source: string, kind: 'extension' | 'user' | 'workspace') => {
    out.push({ file, source, kind });
  };

  const root = (workspaceRoot || '').trim();
  if (root) {
    add(path.join(root, '.cursor', 'mcp.json'), 'This workspace (Cursor)', 'workspace');
    add(path.join(root, '.vscode', 'mcp.json'), 'This workspace (VS Code)', 'workspace');
    add(path.join(root, 'mcp.json'), 'This workspace', 'workspace');
  }

  add(path.join(home, '.cursor', 'mcp.json'), 'Cursor', 'user');
  add(path.join(home, '.olkil', 'mcp.json'), 'OLKIL', 'user');
  add(path.join(appdata, 'Cursor', 'User', 'mcp.json'), 'Cursor', 'user');
  add(path.join(appdata, 'Cursor', 'User', 'settings.json'), 'Cursor', 'user');
  add(path.join(appdata, 'Code', 'User', 'mcp.json'), 'VS Code', 'user');
  add(path.join(appdata, 'Code', 'User', 'settings.json'), 'VS Code', 'user');
  add(path.join(appdata, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop', 'user');
  return out;
}

function readMcpFile(file: string): ParsedServer[] {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return [];
    }
    const raw = parseJsonFile(fs.readFileSync(file, 'utf8'));
    return parseMcpDocument(raw, /settings\.json$/i.test(file));
  } catch {
    return [];
  }
}

function parseMcpDocument(raw: any, settingsFile = false): ParsedServer[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const map = extractServerMap(raw, settingsFile);
  if (!map) {
    return [];
  }
  const out: ParsedServer[] = [];
  for (const [name, value] of Object.entries(map)) {
    const parsed = parseOneServer(String(name), value);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

function parseJsonFile(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(stripped);
  }
}

function extractServerMap(raw: any, settingsFile = false): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (!settingsFile && raw.mcpServers && typeof raw.mcpServers === 'object') {
    return raw.mcpServers as Record<string, unknown>;
  }
  if (!settingsFile && raw.servers && typeof raw.servers === 'object') {
    return raw.servers as Record<string, unknown>;
  }
  if (raw.mcp && typeof raw.mcp === 'object') {
    if (raw.mcp.mcpServers && typeof raw.mcp.mcpServers === 'object') {
      return raw.mcp.mcpServers as Record<string, unknown>;
    }
    if (raw.mcp.servers && typeof raw.mcp.servers === 'object') {
      return raw.mcp.servers as Record<string, unknown>;
    }
  }
  if (settingsFile && raw.mcpServers && typeof raw.mcpServers === 'object') {
    return raw.mcpServers as Record<string, unknown>;
  }
  return null;
}

function parseOneServer(name: string, value: unknown): ParsedServer | null {
  if (!name || !value || typeof value !== 'object') {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const env = stringMap(rec.env || rec.environment);
  const headers = stringMap(rec.headers);
  const fileDisabled = rec.disabled === true || rec.enabled === false;
  const fromExtension =
    /extension/i.test(String(env?.USER_AGENT || rec.source || rec.origin || '')) ||
    Object.keys(headers || {}).some((key) => /hostinger/i.test(key));
  const typeHint = String(rec.type || '').toLowerCase();
  const url = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (url || typeHint === 'http' || typeHint === 'sse' || typeHint === 'remote') {
    if (!url) {
      return null;
    }
    return {
      name,
      type: 'remote',
      url,
      env,
      headers,
      fileDisabled,
      fromExtension,
    };
  }
  const command = joinCommand(rec.command, rec.args);
  if (!command) {
    return null;
  }
  return {
    name,
    type: 'local',
    command,
    env,
    headers,
    fileDisabled,
    fromExtension,
  };
}

function joinCommand(command: unknown, args: unknown): string {
  const parts: string[] = [];
  if (typeof command === 'string' && command.trim()) {
    parts.push(command.trim());
  } else if (Array.isArray(command)) {
    parts.push(...command.map((item) => String(item || '').trim()).filter(Boolean));
  }
  if (Array.isArray(args)) {
    parts.push(...args.map((item) => String(item || '').trim()).filter(Boolean));
  }
  return parts.join(' ').trim();
}

function stringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function publicUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '') || parsed.origin;
  } catch {
    return url.split('?')[0];
  }
}

function isSecretKey(key: string): boolean {
  return /token|key|secret|password|auth|jwt|credential/i.test(key);
}

function slug(value: string): string {
  return String(value || 'src')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'src';
}
