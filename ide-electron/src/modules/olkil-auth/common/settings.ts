/**
 * OLKIL Settings — persisted IDE + agent preferences (Cursor/VS Code-style).
 */

export const IOlkilSettingsService = 'IOlkilSettingsService';
export const OLKIL_SETTINGS_STORAGE_KEY = 'olkil.ide.settings';
export const OLKIL_SETTINGS_SECTION_KEY = 'olkil.settings.section';

export type ChatModeSetting = 'agent' | 'plan' | 'ask';
export type TerminalAutoRun = 'always' | 'allowlist' | 'never';
export type GitCommitStyle = 'conventional' | 'plain';
export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange';
export type WordWrapMode = 'off' | 'on';
export type McpServerType = 'local' | 'remote';
export type ColorThemeId = 'Default Dark+' | 'Default Light+' | 'Default High Contrast';

export type SettingsSectionId =
  | 'general'
  | 'account'
  | 'plan'
  | 'agents'
  | 'models'
  | 'rules'
  | 'mcp'
  | 'indexing'
  | 'git'
  | 'terminal'
  | 'permissions'
  | 'editor'
  | 'privacy'
  | 'about';

export interface OlkilMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  type: McpServerType;
  /** Local: argv string, e.g. `npx -y @modelcontextprotocol/server-github` */
  command?: string;
  /** Remote MCP HTTP/SSE URL */
  url?: string;
}

/** User-added OpenAI-compatible model (own base URL + API key). */
export interface OlkilCustomModel {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  updatedAt: number;
}

export interface OlkilSettings {
  /** Default agent mode for new chats */
  defaultChatMode: ChatModeSetting;
  defaultModelId: string;
  /** Auto router: Cost / Balance / Intelligence (Cursor-style). */
  autoOptimizeFor: 'cost' | 'balanced' | 'intelligence';
  /** Model ids shown in the chat dropdown. Empty = all catalog models. */
  enabledModelIds: string[];
  openAgentOnStart: boolean;
  pinAgentPanel: boolean;
  autoApplyFileEdits: boolean;
  continueOnError: boolean;

  userRules: string;

  terminalAutoRun: TerminalAutoRun;
  terminalAllowlist: string[];
  autoApproveEdits: boolean;
  autoApproveWeb: boolean;
  denyExternalDirectory: boolean;

  gitAllowCommit: boolean;
  gitAllowPush: boolean;
  gitAllowPr: boolean;
  gitCommitStyle: GitCommitStyle;
  gitDefaultBranch: string;

  mcpServers: OlkilMcpServer[];
  /** Discovered (extension/Cursor) MCP ids turned off in OLKIL. */
  mcpDiscoveredDisabled: string[];
  /** User-added OpenAI-compatible models (BYOK). Synced to Firebase when signed in. */
  customModels: OlkilCustomModel[];

  indexCodebase: boolean;
  indexIgnore: string;

  colorTheme: ColorThemeId;
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: WordWrapMode;
  editorMinimap: boolean;
  editorFormatOnSave: boolean;
  filesAutoSave: AutoSaveMode;
  filesExclude: string;
  confirmDelete: boolean;

  shareUsageData: boolean;
  keepChatHistory: boolean;
  includeDotfiles: boolean;
}

export const DEFAULT_TERMINAL_ALLOWLIST: string[] = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'ls',
  'dir',
  'pwd',
  'cat',
  'type',
  'head',
  'tail',
  'rg',
  'grep',
  'find',
  'where',
  'npm test',
  'npm run',
  'yarn',
  'pnpm',
  'npx',
  'python',
  'node',
];

export const DEFAULT_OLKIL_SETTINGS: OlkilSettings = {
  defaultChatMode: 'agent',
  defaultModelId: 'openrouter:auto',
  autoOptimizeFor: 'balanced',
  enabledModelIds: [],
  openAgentOnStart: false,
  pinAgentPanel: false,
  autoApplyFileEdits: false,
  continueOnError: true,
  userRules: '',
  terminalAutoRun: 'always',
  terminalAllowlist: [...DEFAULT_TERMINAL_ALLOWLIST],
  autoApproveEdits: true,
  autoApproveWeb: true,
  denyExternalDirectory: true,
  gitAllowCommit: true,
  gitAllowPush: false,
  gitAllowPr: false,
  gitCommitStyle: 'conventional',
  gitDefaultBranch: 'main',
  mcpServers: [],
  mcpDiscoveredDisabled: [],
  customModels: [],
  indexCodebase: true,
  indexIgnore: 'node_modules\n.git\ndist\nbuild\n.olkil',
  colorTheme: 'Default Dark+',
  editorFontSize: 14,
  editorTabSize: 2,
  editorWordWrap: 'off',
  editorMinimap: true,
  editorFormatOnSave: false,
  filesAutoSave: 'off',
  filesExclude: '**/.git\n**/node_modules\n**/.olkil',
  confirmDelete: true,
  shareUsageData: false,
  keepChatHistory: true,
  includeDotfiles: false,
};

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  group: string;
  keywords: string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'account', label: 'Account', group: 'OLKIL', keywords: 'sign in google profile session logout' },
  { id: 'general', label: 'General', group: 'OLKIL', keywords: 'startup pin panel language default mode' },
  { id: 'plan', label: 'Plan & usage', group: 'OLKIL', keywords: 'credits tokens subscription billing quota lite pro' },
  { id: 'agents', label: 'Agents', group: 'Agent', keywords: 'plan ask agent auto apply diffs continue' },
  { id: 'models', label: 'Models', group: 'Agent', keywords: 'auto openrouter claude gpt gemini grok deepseek dazzlone ollama local cloud default custom openai groq api key byok' },
  { id: 'rules', label: 'Rules', group: 'Agent', keywords: 'user rules agents.md cursorrules prompt' },
  { id: 'mcp', label: 'MCP', group: 'Agent', keywords: 'mcp server model context protocol tools npx hostinger extension cursor vscode' },
  { id: 'indexing', label: 'Indexing', group: 'Agent', keywords: 'codebase index ignore search embeddings' },
  { id: 'git', label: 'Git & PRs', group: 'Workflow', keywords: 'commit push pull request github gitlab branch conventional' },
  { id: 'terminal', label: 'Terminal', group: 'Workflow', keywords: 'shell auto-run command allowlist powershell bash' },
  { id: 'permissions', label: 'Permissions', group: 'Workflow', keywords: 'approve allow deny edit web fetch yolo sandbox' },
  { id: 'editor', label: 'Editor', group: 'IDE', keywords: 'fontsize tab wrap minimap format save' },
  { id: 'privacy', label: 'Privacy', group: 'System', keywords: 'telemetry history analytics crash dotfiles' },
  { id: 'about', label: 'About', group: 'System', keywords: 'version olkil help docs website' },
];

export interface IOlkilSettingsService {
  get(): OlkilSettings;
  patch(partial: Partial<OlkilSettings>): void;
  reset(): void;
  resetSection(keys: Array<keyof OlkilSettings>): void;
  initialize(): Promise<void>;
  /** Merge custom models from Firestore when signed in. Safe to call repeatedly. */
  syncCustomModelsCloud(): Promise<void>;
  onDidChange(listener: (settings: OlkilSettings) => void): { dispose: () => void };
}

export function mergeOlkilSettings(raw: unknown): OlkilSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const next: OlkilSettings = { ...DEFAULT_OLKIL_SETTINGS };
  for (const key of Object.keys(DEFAULT_OLKIL_SETTINGS) as Array<keyof OlkilSettings>) {
    if (src[key] === undefined) {
      continue;
    }
    (next as any)[key] = src[key];
  }
  if (!Array.isArray(next.terminalAllowlist) || next.terminalAllowlist.length === 0) {
    next.terminalAllowlist = [...DEFAULT_TERMINAL_ALLOWLIST];
  }
  if (!Array.isArray(next.mcpServers)) {
    next.mcpServers = [];
  }
  if (!Array.isArray(next.mcpDiscoveredDisabled)) {
    next.mcpDiscoveredDisabled = [];
  }
  if (!Array.isArray(next.enabledModelIds)) {
    next.enabledModelIds = [];
  } else {
    next.enabledModelIds = next.enabledModelIds.filter((id) => typeof id === 'string' && id.trim());
  }
  next.customModels = sanitizeCustomModels(next.customModels);
  next.editorFontSize = clampNum(next.editorFontSize, 10, 24, 14);
  next.editorTabSize = clampNum(next.editorTabSize, 1, 8, 2);
  if (next.terminalAutoRun !== 'always' && next.terminalAutoRun !== 'allowlist' && next.terminalAutoRun !== 'never') {
    next.terminalAutoRun = 'always';
  }
  if (next.defaultChatMode !== 'agent' && next.defaultChatMode !== 'plan' && next.defaultChatMode !== 'ask') {
    next.defaultChatMode = 'agent';
  }
  if (next.autoOptimizeFor !== 'cost' && next.autoOptimizeFor !== 'balanced' && next.autoOptimizeFor !== 'intelligence') {
    next.autoOptimizeFor = 'balanced';
  }
  if (next.enabledModelIds.some((id) => /^deepseek:|poolside:/.test(id) || /\bdazzlone\b/i.test(id))) {
    next.enabledModelIds = [];
  }
  if (/^deepseek:|poolside:/.test(String(next.defaultModelId || '')) || /\bdazzlone\b/i.test(String(next.defaultModelId || ''))) {
    next.defaultModelId = 'openrouter:auto';
  }
  return next;
}

export function isModelEnabledInSettings(settings: OlkilSettings, modelId: string): boolean {
  if (!settings.enabledModelIds.length) {
    return true;
  }
  return settings.enabledModelIds.includes(modelId);
}

export function toggleEnabledModelId(
  settings: OlkilSettings,
  modelId: string,
  enabled: boolean,
  catalogIds: string[],
): { enabledModelIds: string[]; defaultModelId: string } {
  const current = settings.enabledModelIds.length
    ? settings.enabledModelIds.filter((id) => catalogIds.includes(id))
    : [...catalogIds];
  let next = enabled ? Array.from(new Set([...current, modelId])) : current.filter((id) => id !== modelId);
  if (!next.length) {
    next = [modelId];
  }
  const enabledModelIds = catalogIds.filter((id) => next.includes(id));
  const defaultModelId = enabledModelIds.includes(settings.defaultModelId)
    ? settings.defaultModelId
    : enabledModelIds[0] || settings.defaultModelId;
  return { enabledModelIds, defaultModelId };
}

export function newMcpServerId(): string {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newCustomModelId(): string {
  return `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function customModelCatalogId(id: string): string {
  const raw = String(id || '').trim();
  if (!raw) {
    return '';
  }
  return raw.startsWith('custom:') ? raw : `custom:${raw}`;
}

export function mergeCustomModelLists(
  local: OlkilCustomModel[],
  remote: OlkilCustomModel[],
): OlkilCustomModel[] {
  const byId = new Map<string, OlkilCustomModel>();
  for (const item of [...remote, ...local]) {
    const clean = sanitizeCustomModel(item);
    if (!clean) {
      continue;
    }
    const prev = byId.get(clean.id);
    if (!prev || clean.updatedAt >= prev.updatedAt) {
      byId.set(clean.id, clean);
    }
  }
  return [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt);
}

function sanitizeCustomModels(raw: unknown): OlkilCustomModel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: OlkilCustomModel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const clean = sanitizeCustomModel(item);
    if (!clean || seen.has(clean.id)) {
      continue;
    }
    seen.add(clean.id);
    out.push(clean);
  }
  return out;
}

function sanitizeCustomModel(raw: unknown): OlkilCustomModel | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const src = raw as Record<string, unknown>;
  const id = String(src.id || '').trim();
  const model = String(src.model || '').trim();
  const baseUrl = String(src.baseUrl || '').trim();
  if (!id || !model || !baseUrl) {
    return null;
  }
  const updatedAt = Number(src.updatedAt);
  return {
    id,
    label: String(src.label || model).trim() || model,
    model,
    baseUrl,
    apiKey: String(src.apiKey || '').trim(),
    enabled: src.enabled !== false,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}
