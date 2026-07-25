export const OLKIL_AI_ID = 'olkil-ai';
export const OLKIL_AI_CONTAINER_ID = 'olkil-ai';
export const OlkilAiNodeServicePath = 'OlkilAiNodeServicePath';
export const IOlkilAiNodeService = 'IOlkilAiNodeService';
export const IOlkilChatService = 'IOlkilChatService';

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
  /** Model catalog id, e.g. openrouter:openai/gpt-4o-mini */
  modelId?: string;
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

export interface IOlkilAiNodeService {
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  getStreamState(streamId: string): Promise<ChatStreamState>;
  getModelName(modelId?: string): Promise<string>;
  hasApiKey(provider?: string): Promise<boolean>;
  listModels(): Promise<
    Array<{ id: string; provider: string; model: string; label: string }>
  >;
}

export type FileChangeKind = 'edit' | 'create' | 'rename';
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
  models: Array<{ id: string; provider: string; model: string; label: string }>;
  /** 'agent' = autonomous edits; 'plan' = discuss first */
  chatMode: 'agent' | 'plan';
  /** Pending (not yet accepted/reverted) file changes from the agent */
  pendingChanges: FileChangeInfo[];
  onDidChange: any;
  init(): Promise<void>;
  send(text: string): Promise<void>;
  setModel(modelId: string): void;
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
