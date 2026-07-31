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
  /** Override default max_tokens (helps avoid provider 500s on huge replies). */
  maxTokens?: number;
}

/** Files/folders attached via @mention or drag-drop for agent context. */
export interface ChatAttachment {
  path: string;
  /** Relative display path */
  name: string;
  kind: 'file' | 'folder';
}

export interface ChatCompletionResult {
  content: string;
  tool_calls?: ChatToolCall[];
  finish_reason?: string;
}

export interface ChatStreamState {
  text: string;
  done: boolean;
  error?: string;
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
  investigateRepository(root: string, query: string, limit?: number): Promise<InvestigationResult>;
  refreshRepositoryFiles(root: string, filePaths: string[]): Promise<void>;
  getModelName(modelId?: string): Promise<string>;
  hasApiKey(provider?: string): Promise<boolean>;
  listModels(): Promise<
    Array<{
      id: string;
      provider: string;
      model: string;
      label: string;
      displayName?: string;
      badge?: string;
      approxSizeGb?: number;
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
}

export interface UiChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'status' | 'file_change';
  content: string;
  pending?: boolean;
  fileChange?: FileChangeInfo;
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
  }>;
  /** 'agent' = autonomous edits; 'plan' = discuss first */
  chatMode: 'agent' | 'plan';
  /** Local Ollama download / readiness for the selected model */
  ollamaDownload: OllamaDownloadUiState;
  /** Pending (not yet accepted/reverted) file changes from the agent */
  pendingChanges: FileChangeInfo[];
  onDidChange: any;
  init(): Promise<void>;
  send(text: string, attachments?: ChatAttachment[]): Promise<void>;
  /** Fuzzy file/folder list for @mention picker. */
  listMentionCandidates(query: string, limit?: number): Promise<ChatAttachment[]>;
  setModel(modelId: string): void;
  /** User clicked Download — start Ollama engine + model pull with progress. */
  startOllamaDownload(): Promise<void>;
  pauseOllamaDownload(): Promise<void>;
  cancelOllamaDownload(): Promise<void>;
  setChatMode(mode: 'agent' | 'plan'): void;
  clear(): void;
  stop(): void;
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
