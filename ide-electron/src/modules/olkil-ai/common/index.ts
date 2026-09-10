export const OLKIL_AI_ID = 'olkil-ai';
export const OLKIL_AI_CONTAINER_ID = 'olkil-ai';
export const OlkilAiNodeServicePath = 'OlkilAiNodeServicePath';
export const IOlkilAiNodeService = 'IOlkilAiNodeService';
export const IOlkilChatService = 'IOlkilChatService';
export const IOlkilChatUiService = 'IOlkilChatUiService';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  id?: string;
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
  stream?: boolean;
  /** When set with stream:true, browser can poll getStreamState(streamId) for live text */
  streamId?: string;
  /** Model catalog id, e.g. poolside:poolside/laguna-s-2.1 (Dazzlone) */
  modelId?: string;
  /** Cursor Auto optimize-for: cost | balanced | intelligence */
  autoOptimizeFor?: 'cost' | 'balanced' | 'intelligence';
  /** Override default max_tokens (helps avoid provider 500s on huge replies). */
  maxTokens?: number;
  /** User-added OpenAI-compatible models for this request (BYOK). */
  customModels?: Array<{
    id: string;
    label: string;
    model: string;
    baseUrl: string;
    apiKey: string;
  }>;
}

/** Files/folders attached via @mention or drag-drop for agent context. */
export interface ChatAttachment {
  path: string;
  /** Relative display path */
  name: string;
  kind: 'file' | 'folder' | 'image' | 'codebase' | 'problems' | 'git' | 'selection' | 'docs' | 'web';
  /** Optional base64 data URL for images */
  dataUrl?: string;
  mimeType?: string;
}

export interface ChatCompletionResult {
  content: string;
  tool_calls?: ChatToolCall[];
  finish_reason?: string;
  /** Provider usage from the API — never estimated. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    native_tokens_prompt?: number;
    native_tokens_completion?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  /** OpenRouter generation id for native token lookup. */
  generationId?: string;
}

export interface ChatStreamState {
  text: string;
  done: boolean;
  error?: string;
  /** Tool names discovered so far while streaming (Cursor-style live activity) */
  toolNames?: string[];
}

export interface RepositoryIndexStatus {
  root: string;
  state: 'idle' | 'loading' | 'indexing' | 'ready' | 'error';
  files: number;
  symbols: number;
  edges: number;
  indexedAt?: number;
  elapsedMs?: number;
  error?: string;
}

export interface RepositorySearchHit {
  path: string;
  score: number;
  language: string;
  reason: string[];
  symbols: string[];
  excerpt: string;
  dependencies: string[];
  dependents: string[];
}

export interface RepositorySearchResult {
  status: RepositoryIndexStatus;
  query: string;
  hits: RepositorySearchHit[];
}

export interface RepositorySymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  role: 'definition' | 'reference';
  detail?: string;
  score: number;
}

export interface RepositorySymbolResult {
  status: RepositoryIndexStatus;
  symbol: string;
  hits: RepositorySymbolHit[];
}

export interface RepositoryGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface RepositoryGrepResult {
  engine: 'ripgrep' | 'unavailable';
  query: string;
  elapsedMs: number;
  truncated: boolean;
  matches: RepositoryGrepMatch[];
}

export interface RepositoryOverview {
  status: RepositoryIndexStatus;
  languages: Array<{ language: string; files: number }>;
  topDirectories: Array<{ path: string; files: number }>;
  entrypoints: string[];
  hubs: Array<{ path: string; dependencies: number; dependents: number }>;
}

export type CodeRelationType =
  | 'seed'
  | 'imports'
  | 'imported_by'
  | 'calls'
  | 'called_by'
  | 'renders'
  | 'rendered_by'
  | 'api_calls'
  | 'api_handles'
  | 'same_module'
  | 'semantic';

export interface InvestigationIntent {
  kind: 'bug' | 'feature' | 'refactor' | 'question';
  concepts: string[];
  expandedConcepts: string[];
  modulePhrases: string[];
}

export interface InvestigationEvidence {
  path: string;
  score: number;
  depth: number;
  via: CodeRelationType;
  from?: string;
  reasons: string[];
  symbols: string[];
  calls: string[];
  apiEndpoints: string[];
  excerpt: string;
}

export interface InvestigationResult {
  status: RepositoryIndexStatus;
  query: string;
  intent: InvestigationIntent;
  confidence: number;
  evidence: InvestigationEvidence[];
  trails: string[][];
  gaps: string[];
}

/** First-run local AI (Ollama) bootstrap progress, polled by the browser. */
export type OllamaSetupPhase =
  | 'idle'
  | 'locating'
  | 'starting'
  | 'checking'
  | 'pulling'
  | 'paused'
  | 'cancelled'
  | 'ready'
  | 'error';

export interface OllamaSetupState {
  phase: OllamaSetupPhase;
  model?: string;
  message?: string;
  /** 0..100 while pulling */
  percent?: number;
  totalBytes?: number;
  completedBytes?: number;
  error?: string;
}

/** Snapshot of whether a catalog model is usable locally (no download started). */
export interface LocalModelStatus {
  modelId: string;
  provider: string;
  model: string;
  /** Ollama HTTP is reachable */
  engineRunning: boolean;
  /** Model weights are already on disk */
  installed: boolean;
  approxSizeGb?: number;
}

/** Background / foreground shell command. */
export interface CommandRunRequest {
  command: string;
  cwd?: string;
  background?: boolean;
  timeoutMs?: number;
  /** Extra wait before returning background process output (ms). */
  settleMs?: number;
}

export interface CommandRunResult {
  id: string;
  command: string;
  cwd: string;
  background: boolean;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  urls: string[];
  pid?: number;
  elapsedMs?: number;
  error?: string;
}

export interface DevServerDetectResult {
  root: string;
  packageManager: 'npm' | 'yarn' | 'pnpm';
  scripts: string[];
  recommendedCommand: string | null;
  suggestedUrls: string[];
  frameworkHints: string[];
  error?: string;
}

export interface IOlkilAiNodeService {
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  getStreamState(streamId: string): Promise<ChatStreamState>;
  ensureRepositoryIndex(root: string): Promise<RepositoryIndexStatus>;
  getRepositoryIndexStatus(root: string): Promise<RepositoryIndexStatus>;
  searchRepository(root: string, query: string, limit?: number): Promise<RepositorySearchResult>;
  exactRepositorySearch(root: string, query: string, limit?: number): Promise<RepositorySearchResult>;
  grepRepository(
    root: string,
    query: string,
    options?: { maxResults?: number; regex?: boolean; caseSensitive?: boolean },
  ): Promise<RepositoryGrepResult>;
  findSymbolDefinitions(root: string, symbol: string, limit?: number): Promise<RepositorySymbolResult>;
  findSymbolReferences(root: string, symbol: string, limit?: number): Promise<RepositorySymbolResult>;
  getRepositoryOverview(root: string): Promise<RepositoryOverview>;
  getRelatedFiles(root: string, filePath: string, limit?: number): Promise<RepositorySearchResult>;
  /** Fuzzy module/folder discovery: "application timeline" → ApplicationTimeline / application-timeline. */
  findModules(root: string, query: string, limit?: number): Promise<RepositorySearchResult>;
  findFilesByName(
    root: string,
    query: string,
    limit?: number,
  ): Promise<{ files: string[]; engine: 'index' | 'empty'; elapsedMs: number }>;
  investigateRepository(root: string, query: string, limit?: number): Promise<InvestigationResult>;
  refreshRepositoryFiles(root: string, filePaths: string[]): Promise<void>;
  getModelName(modelId?: string): Promise<string>;
  hasApiKey(provider?: string): Promise<boolean>;
  getDeepseekAccess(): Promise<{
    signedIn: boolean;
    isPaid: boolean;
    used: number;
    limit: number;
    remaining: number;
    locked: boolean;
  }>;
  listModels(): Promise<
    Array<{
      id: string;
      provider: string;
      model: string;
      label: string;
      displayName?: string;
      badge?: string;
      approxSizeGb?: number;
      group?: string;
    }>
  >;
  /** Check if an Ollama model is already downloaded (does not start pull). */
  getLocalModelStatus(modelId?: string): Promise<LocalModelStatus>;
  /**
   * Ensure local Ollama is installed, running, and the given model is present.
   * Kicks off (or resumes) background setup and returns the current state.
   */
  ensureLocalModel(modelId?: string): Promise<OllamaSetupState>;
  /** Poll current local-AI setup progress. */
  getSetupState(): Promise<OllamaSetupState>;
  /** Pause an in-progress Ollama model download (resumable). */
  pauseLocalModelDownload(): Promise<OllamaSetupState>;
  /** Cancel an in-progress Ollama model download. */
  cancelLocalModelDownload(): Promise<OllamaSetupState>;

  /** Detect package.json scripts / framework. */
  detectDevServer(root: string): Promise<DevServerDetectResult>;
  /** Run a shell command in the workspace (optionally background for `npm run dev`). */
  runCommand(request: CommandRunRequest): Promise<CommandRunResult>;
  getCommandOutput(id: string): Promise<CommandRunResult | null>;
  stopCommand(id: string): Promise<boolean>;

  /**
   * Run the coding agent (OpenCode sidecar). Branding stays OLKIL.
   * IPC names are historical (`clineRun`) and must stay stable.
   */
  clineRun(request: ClineEngineRunRequest): Promise<ClineEngineRunState>;
  /** Poll live agent text / tool activities. */
  clineGetState(runId: string): Promise<ClineEngineRunState>;
  /** Abort an in-flight agent run. */
  clineCancel(runId: string): Promise<boolean>;
  /** MCP servers discovered from Cursor/VS Code/extension mcp.json files (no secrets). */
  listDiscoveredMcpServers(workspaceRoot?: string): Promise<DiscoveredMcpServer[]>;
  /** Probe an OpenAI-compatible custom endpoint before saving. */
  probeCustomModel(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{ ok: boolean; error?: string; hint?: string }>;
}

export interface DiscoveredMcpServer {
  id: string;
  name: string;
  type: 'local' | 'remote';
  command?: string;
  url?: string;
  source: string;
  sourceKind: 'extension' | 'user' | 'workspace';
  hasAuth: boolean;
  fileDisabled: boolean;
}

/** Request payload for the embedded coding agent. */
export interface ClineEngineRunRequest {
  runId: string;
  prompt: string;
  workspaceRoot: string;
  activeFile?: string;
  mode: 'agent' | 'plan' | 'ask';
  modelId?: string;
  autoOptimizeFor?: 'cost' | 'balanced' | 'intelligence';
  rules?: string;
  autoApprove?: boolean;
  /** File writes inside the workspace */
  autoApproveEdits?: boolean;
  /** Public URL fetch */
  autoApproveWeb?: boolean;
  /** Shell during a run: always / matching prefixes only / never */
  terminalAutoRun?: 'always' | 'allowlist' | 'never';
  terminalAllowlist?: string[];
  mcpServers?: Array<{
    name: string;
    enabled: boolean;
    type: 'local' | 'remote';
    command?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }>;
  /** Discovered MCP ids the user turned off in OLKIL Settings. */
  mcpDiscoveredDisabled?: string[];
  /** User-added OpenAI-compatible models (own key + base URL). */
  customModels?: Array<{
    id: string;
    label: string;
    model: string;
    baseUrl: string;
    apiKey: string;
  }>;
  /** Stable Olkil chat id — OpenCode reuses this session so large repos are not re-explored every turn. */
  conversationId?: string;
}

export interface ClineEngineActivity {
  id: string;
  kind: ActivityKind;
  label: string;
  done?: boolean;
  filePath?: string;
  command?: string;
  argsPreview?: string;
  resultPreview?: string;
  groupId?: string;
  parentId?: string;
  lineRange?: string;
  filesExplored?: number;
  searchCount?: number;
}

export interface ClineEngineFileChange {
  id: string;
  kind: FileChangeKind;
  path: string;
  beforeContent: string | null;
  afterContent: string | null;
}

export interface ClineEngineRunState {
  runId: string;
  done: boolean;
  text: string;
  reasoning?: string;
  error?: string;
  activities: ClineEngineActivity[];
  status?: string;
  /** Live file edits for Olkil accept/revert cards */
  fileChanges?: ClineEngineFileChange[];
}

export type FileChangeKind = 'edit' | 'create' | 'rename' | 'delete';
export type FileChangeStatus = 'pending' | 'accepted' | 'reverted';

export interface FileDiffLine {
  type: 'context' | 'add' | 'del' | 'gap';
  lineNumber?: number;
  text: string;
}

/** Chat-visible summary of an agent file edit (Cursor-style card). */
export interface FileChangeInfo {
  id: string;
  kind: FileChangeKind;
  path: string;
  /** Relative / display path shown in the card header */
  displayName: string;
  /** For rename: destination path */
  newPath?: string;
  newDisplayName?: string;
  additions: number;
  deletions: number;
  status: FileChangeStatus;
  preview: FileDiffLine[];
  /** Short description of what changed */
  summary?: string;
  /** How many tool edits were merged into this card */
  editCount?: number;
  /** Cursor-style per-hunk review */
  hunks?: Array<{
    id: string;
    title: string;
    additions: number;
    deletions: number;
    status: 'pending' | 'accepted' | 'rejected';
    preview: FileDiffLine[];
  }>;
  /** When true, card shows full preview */
  expanded?: boolean;
}

/** Cursor-style live tool / thinking row in the transcript. */
export type ActivityKind =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'browsing'
  | 'indexing'
  | 'done'
  | 'info'
  | 'todo';

export interface ActivityInfo {
  kind: ActivityKind;
  label: string;
  detail?: string;
  /** When true, row shows as completed (checkmark style). */
  done?: boolean;
  /** Engine / tool call id — used to complete the matching live row. */
  toolCallId?: string;
  /** Tool function name for expandable cards */
  toolName?: string;
  /** Pretty-printed args (truncated) */
  argsPreview?: string;
  /** Truncated tool result / thinking body */
  resultPreview?: string;
  /** Absolute or workspace-relative path — click opens editor */
  filePath?: string;
  /** Shell command line when kind=running */
  command?: string;
  exitCode?: number | null;
  /** Nested exploration group (Cursor-style). */
  groupId?: string;
  parentId?: string;
  lineRange?: string;
  filesExplored?: number;
  searchCount?: number;
}

/** Cursor TodoWrite-style checklist item. */
export interface AgentTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface QueuedChatMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
}

export interface UiChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'status' | 'file_change' | 'activity' | 'todos';
  content: string;
  pending?: boolean;
  fileChange?: FileChangeInfo;
  activity?: ActivityInfo;
  /** Context pills under a user bubble */
  attachments?: ChatAttachment[];
  /** Sticky agent todo checklist */
  todos?: AgentTodoItem[];
  /** Parsed follow-up suggestion chips under assistant reply */
  suggestions?: string[];
}

export interface IOlkilChatService {
  messages: UiChatMessage[];
  status: string;
  busy: boolean;
  modelName: string;
  modelId: string;
  models: Array<{
    id: string;
    provider: string;
    model: string;
    label: string;
    displayName?: string;
    badge?: string;
    approxSizeGb?: number;
    group?: string;
  }>;
  /** 'agent' = autonomous edits; 'plan' = discuss first; 'ask' = read-only */
  chatMode: 'agent' | 'plan' | 'ask';
  /** Free-plan DeepSeek 50k token cap used up — models stay visible but locked. */
  deepseekLocked: boolean;
  /** Local Ollama download / readiness for the selected model */
  ollamaDownload: OllamaDownloadUiState;
  /** Pending (not yet accepted/reverted) file changes from the agent */
  pendingChanges: FileChangeInfo[];
  /** Messages waiting while the agent is busy (Cursor-style queue) */
  queuedMessages: QueuedChatMessage[];
  /** Latest agent todo checklist (also mirrored in transcript) */
  agentTodos: AgentTodoItem[];
  /** Checkpoint stack for rewind */
  checkpoints: Array<{ id: string; label: string; createdAt: number }>;
  /** Signed-in user's recent chats (max 3, 48h TTL on Firebase) */
  chatHistory: Array<{
    id: string;
    title: string;
    updatedAt: number;
    expiresAt: number;
    messageCount: number;
  }>;
  onDidChange: any;
  init(): Promise<void>;
  send(
    text: string,
    attachments?: ChatAttachment[],
    opts?: { historyText?: string },
  ): Promise<void>;
  /** Fuzzy file/folder list for @mention picker. */
  listMentionCandidates(query: string, limit?: number): Promise<ChatAttachment[]>;
  setModel(modelId: string): void;
  /** User clicked Download — start Ollama engine + model pull with progress. */
  startOllamaDownload(): Promise<void>;
  pauseOllamaDownload(): Promise<void>;
  cancelOllamaDownload(): Promise<void>;
  setChatMode(mode: 'agent' | 'plan' | 'ask'): void;
  clear(): void;
  /** Persist current chat (if signed in), then start a fresh session. */
  newChat(): void;
  /** Load a saved chat from Firebase history. */
  loadChatHistory(id: string): Promise<void>;
  stop(): void;
  /** Drop a queued follow-up before it runs. */
  cancelQueued(id: string): void;
  /** Re-run from the last user message (Cursor regenerate). */
  regenerate(): Promise<void>;
  /** Edit a prior user message and resubmit from there. */
  editAndResend(messageId: string, text: string): Promise<void>;
  /** Restore files + chat to a checkpoint. */
  restoreCheckpoint(checkpointId: string): Promise<void>;
  /** Create a named checkpoint of current pending file snapshots. */
  createCheckpoint(label?: string): string;
  /** Open a workspace path from an activity / citation click. */
  openPath(filePath: string, line?: number): Promise<void>;
  /** Cmd-K style: rewrite the current selection with an instruction. */
  inlineEdit(instruction: string): Promise<void>;
  /** Accept / reject a single hunk inside a file change card. */
  acceptHunk(changeId: string, hunkId: string): Promise<void>;
  rejectHunk(changeId: string, hunkId: string): Promise<void>;
  acceptChange(changeId: string): Promise<void>;
  revertChange(changeId: string): Promise<void>;
  acceptAllPending(): Promise<void>;
  revertAllPending(): Promise<void>;
  /** Open the changed file in the editor (and refresh pending diff highlights). */
  openChangeFile(changeId: string): Promise<void>;
}

/** Browser-facing Ollama download panel state. */
export type OllamaDownloadUiPhase =
  | 'idle'
  | 'ready'
  | 'needs_download'
  | 'starting'
  | 'downloading'
  | 'paused'
  | 'error';

export interface OllamaDownloadUiState {
  phase: OllamaDownloadUiPhase;
  modelId?: string;
  model?: string;
  label?: string;
  percent: number;
  message: string;
  totalBytes?: number;
  completedBytes?: number;
  approxSizeGb?: number;
  error?: string;
}

/**
 * Presentation state of the floating agent panel.
 * - `closed`: nothing but the launcher button is visible
 * - `open`: panel docked to the right edge of the workbench
 * - `minimized`: panel folded into a compact pill in the top-right corner
 */
export type ChatPanelState = 'closed' | 'open' | 'minimized';

export const CHAT_PANEL_MIN_WIDTH = 340;
export const CHAT_PANEL_MAX_WIDTH = 900;
export const CHAT_PANEL_DEFAULT_WIDTH = 440;

export interface IOlkilChatUiService {
  state: ChatPanelState;
  /** Panel stretches across most of the workbench instead of the right rail. */
  expanded: boolean;
  /** When pinned, opening a file no longer folds the panel away. */
  pinned: boolean;
  width: number;
  onDidChange: any;
  /** Wires the editor listener; safe to call more than once. */
  init(): void;
  open(): void;
  close(): void;
  toggle(): void;
  minimize(): void;
  restore(): void;
  setExpanded(expanded: boolean): void;
  setPinned(pinned: boolean): void;
  setWidth(width: number): void;
}

export * from './virtual-office';
