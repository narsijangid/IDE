/**
 * Virtual Office — multi-agent mode (separate from single-agent chat).
 * UI lives in VertualOffice/vertualoffice.html (iframe); this is the IDE bridge.
 */

export const OLKIL_VIRTUAL_OFFICE_SCHEME = 'olkil-voffice';
export const IOlkilVirtualOfficeService = 'IOlkilVirtualOfficeService';

/** Stable editor URI so open/close always target the same tab. */
export const OLKIL_VIRTUAL_OFFICE_URI = `${OLKIL_VIRTUAL_OFFICE_SCHEME}:/office`;

/** Chat assignee: Manager auto-picks a free developer, or direct worker id. */
export type VirtualOfficeAssigneeId = 'manager' | 'alex' | 'elon' | 'sophia' | 'robert' | 'jasmine';

export interface VirtualOfficeWorker {
  id: Exclude<VirtualOfficeAssigneeId, 'manager'>;
  name: string;
  role: string;
}

/** Fixed roster — must match VertualOffice/vertualoffice.html WORKERS. */
export const VIRTUAL_OFFICE_WORKERS: VirtualOfficeWorker[] = [
  { id: 'alex', name: 'Alex', role: 'Developer' },
  { id: 'elon', name: 'Elon', role: 'Developer' },
  { id: 'sophia', name: 'Sophia', role: 'Developer' },
  { id: 'robert', name: 'Robert', role: 'Developer' },
  { id: 'jasmine', name: 'Jasmine', role: 'QA' },
];

export const VIRTUAL_OFFICE_ASSIGNEES: Array<{
  id: VirtualOfficeAssigneeId;
  name: string;
  role: string;
}> = [
  { id: 'manager', name: 'Manager', role: 'Auto-assign to free teammate' },
  ...VIRTUAL_OFFICE_WORKERS,
];

export const MAX_VIRTUAL_OFFICE_PARALLEL = 4;

export interface VirtualOfficeLiveActivity {
  id: string;
  label: string;
  done?: boolean;
  kind?: string;
  filePath?: string;
}

export interface VirtualOfficeLiveFile {
  path: string;
  kind: string;
}

export interface VirtualOfficeTask {
  id: string;
  workerId: string;
  workerName: string;
  title: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  runId: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  /** Live engine status label */
  liveStatus?: string;
  activities: VirtualOfficeLiveActivity[];
  files: VirtualOfficeLiveFile[];
  /** live-test = Jasmine QA via Dev Studio browser loop (no Cline run). */
  engine?: 'cline' | 'live-test';
}

/** Snapshot shown when user clicks a person on the floor. */
export interface VirtualOfficeWorkerBrief {
  workerId: string;
  workerName: string;
  role: string;
  deskStatus: 'idle' | 'working' | 'done' | 'error';
  task: VirtualOfficeTask | null;
}

export interface IOlkilVirtualOfficeService {
  /** True while the Virtual Office tab / mode is active. */
  readonly active: boolean;
  /** Chat dropdown selection: manager or a developer. */
  readonly assigneeId: VirtualOfficeAssigneeId;
  readonly tasks: VirtualOfficeTask[];
  /** Worker currently inspected from the floor click. */
  readonly inspectedWorkerId: string | null;
  onDidChange(listener: () => void): { dispose: () => void };

  enter(): void;
  exit(): void;
  setAssignee(id: VirtualOfficeAssigneeId): void;

  /**
   * Bind the iframe contentWindow so we can drive OfficeAI animations.
   * Safe to call when the tab mounts / remounts.
   */
  bindFrame(win: Window | null): void;

  /**
   * Assign work: animates office UI + runs parallel cline agent.
   * Does not set single-agent chat.busy.
   */
  assignFromChat(prompt: string, opts?: { modelId?: string; mode?: 'agent' | 'plan' | 'ask' }): Promise<VirtualOfficeTask>;

  /**
   * Live Test from chat while Virtual Office is open: Jasmine (QA) takes the desk
   * visually. Actual browser testing still runs on the Dev Studio live-test engine.
   */
  beginLiveQa(goal: string): string | null;
  endLiveQa(
    taskId: string,
    result: { status: 'completed' | 'failed' | 'cancelled'; summary?: string },
  ): void;

  /** Floor click — focus this worker's live brief in chat. */
  inspectWorker(workerId: string): void;
  clearInspect(): void;
  getWorkerBrief(workerId: string): VirtualOfficeWorkerBrief | null;

  completeWorker(workerId: string): void;
  cancelTask(taskId: string): Promise<void>;
  stopAll(): Promise<void>;
}

export function buildVirtualOfficeAgentPrompt(workerName: string, role: string, taskPrompt: string): string {
  const specialty =
    role === 'QA'
      ? 'Focus on testing, edge cases, regressions, and clear bug reports.'
      : 'You are a full-stack capable developer. Ship clean, minimal, high-quality code.';
  return [
    `You are ${workerName}, ${role} on the OLKIL Virtual Office team.`,
    specialty,
    'Work only inside the open workspace. Prefer minimal, high-quality changes.',
    'Finish with a short summary of what you changed.',
    '',
    'ASSIGNED TASK:',
    taskPrompt.trim(),
  ].join('\n');
}

export function titleFromPrompt(prompt: string, max = 56): string {
  const line = prompt.trim().split(/\r?\n/)[0] || 'Untitled task';
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function basenamePath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}
