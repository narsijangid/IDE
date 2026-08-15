export type TaskSize = 'simple' | 'medium' | 'large';

export interface TaskRoute {
  size: TaskSize;
  reason: string;
  maxIterations: number;
  maxContinues: number;
  prefetchBudgetMs: number;
  maxPrefetchFiles: number;
  maxPrefetchSearches: number;
  maxContextChars: number;
  allowDeepInvestigate: boolean;
  promptHint: string;
}

export interface EnvironmentInfo {
  os: NodeJS.Platform;
  osRelease: string;
  arch: string;
  shell: string;
  shellKind: 'powershell' | 'cmd' | 'bash' | 'unknown';
  powershellVersion?: string;
  nodeVersion?: string;
  python?: string;
  git?: string;
  gitRoot?: string;
  packageManager?: string;
  projectType?: string;
  detectedAt: number;
}

export interface AgentTelemetry {
  taskId: string;
  taskSize: TaskSize;
  llmCalls: number;
  toolCalls: number;
  parallelToolCalls: number;
  sequentialToolCalls: number;
  filesExplored: number;
  filesRead: number;
  searches: number;
  contextChars: number;
  cacheHits: number;
  cacheMisses: number;
  planningTimeMs: number;
  retrievalTimeMs: number;
  editingTimeMs: number;
  validationTimeMs: number;
  totalTimeMs: number;
  prefetchUsed: boolean;
  fallbackToPlainCline: boolean;
}

export interface ActivitySinkEvent {
  id: string;
  kind:
    | 'thinking'
    | 'reading'
    | 'searching'
    | 'editing'
    | 'running'
    | 'browsing'
    | 'indexing'
    | 'todo'
    | 'done'
    | 'info';
  label: string;
  done?: boolean;
  groupId?: string;
  parentId?: string;
  filePath?: string;
  command?: string;
  argsPreview?: string;
  resultPreview?: string;
  lineRange?: string;
  filesExplored?: number;
  searchCount?: number;
}

export type ActivitySink = (event: ActivitySinkEvent) => void;

export interface CompactEvidence {
  path: string;
  score: number;
  reason: string[];
  symbols: string[];
  excerpt?: string;
  line?: number;
}

export interface PatternCard {
  file: string;
  symbol?: string;
  score: number;
  pattern: string[];
  related: string[];
}

export interface CompactTaskContext {
  task: string;
  size: TaskSize;
  relevantFiles: CompactEvidence[];
  relevantSymbols: Array<{ name: string; kind: string; path: string; line: number; role: string }>;
  reference?: PatternCard;
  relatedBackend: string[];
  relatedFrontend: string[];
  constraints: string[];
  git?: string;
  environment?: string;
  text: string;
  filesExplored: number;
  searches: number;
}

export interface SessionSnapshot {
  task: string;
  plan: string;
  relevantFiles: string[];
  decisions: string[];
  constraints: string[];
  changes: string[];
  validation: string;
  unresolved: string[];
  searchesDone: string[];
  filesRead: string[];
}
