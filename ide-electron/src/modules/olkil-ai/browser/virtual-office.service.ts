import { Autowired, Injectable } from '@opensumi/di';
import { Disposable, Emitter, Event, URI } from '@opensumi/ide-core-common';
import { AppConfig } from '@opensumi/ide-core-browser';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor/lib/browser';
import {
  buildVirtualOfficeAgentPrompt,
  IOlkilVirtualOfficeService,
  MAX_VIRTUAL_OFFICE_PARALLEL,
  titleFromPrompt,
  VIRTUAL_OFFICE_WORKERS,
  VirtualOfficeAssigneeId,
  VirtualOfficeLiveActivity,
  VirtualOfficeLiveFile,
  VirtualOfficeTask,
  VirtualOfficeWorkerBrief,
} from '../common/virtual-office';
import { IOlkilAiNodeService, OlkilAiNodeServicePath } from '../common';

const POLL_MS = 400;
const MAX_ACTIVITIES = 20;

let taskSeq = 0;
let runSeq = 0;

function nextTaskId(): string {
  return `vo_task_${Date.now()}_${++taskSeq}`;
}

function nextRunId(): string {
  return `vo_run_${Date.now()}_${++runSeq}`;
}

@Injectable()
export class OlkilVirtualOfficeService extends Disposable implements IOlkilVirtualOfficeService {
  @Autowired(OlkilAiNodeServicePath)
  private aiNode!: IOlkilAiNodeService;

  @Autowired(IWorkspaceService)
  private workspaceService!: IWorkspaceService;

  @Autowired(AppConfig)
  private appConfig!: AppConfig;

  @Autowired(WorkbenchEditorService)
  private editorService!: WorkbenchEditorService;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  active = false;
  assigneeId: VirtualOfficeAssigneeId = 'manager';
  tasks: VirtualOfficeTask[] = [];
  inspectedWorkerId: string | null = null;
  /** Ignore view remount enter() right after an intentional Dev Studio exit. */
  private suppressEnterUntil = 0;

  private frameWin: Window | null = null;
  private frameReady = false;
  private pendingAnim: Array<{ type: string; workerId?: string; task?: string }> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fireQueued = false;
  private runPromises = new Map<string, Promise<void>>();
  private workerTask = new Map<string, string>();
  private messageHandler?: (ev: MessageEvent) => void;

  enter() {
    if (Date.now() < this.suppressEnterUntil) {
      return;
    }
    if (this.active) {
      return;
    }
    this.active = true;
    this.fire();
  }

  exit() {
    this.suppressEnterUntil = Date.now() + 1500;
    if (!this.active && !this.inspectedWorkerId) {
      this.fire(true);
      return;
    }
    this.active = false;
    this.inspectedWorkerId = null;
    this.fire(true);
  }

  setAssignee(id: VirtualOfficeAssigneeId) {
    this.assigneeId = id;
    this.fire();
  }

  inspectWorker(workerId: string) {
    if (!VIRTUAL_OFFICE_WORKERS.some((w) => w.id === workerId)) {
      return;
    }
    this.inspectedWorkerId = workerId;
    this.fire();
  }

  clearInspect() {
    if (!this.inspectedWorkerId) {
      return;
    }
    this.inspectedWorkerId = null;
    this.fire();
  }

  getWorkerBrief(workerId: string): VirtualOfficeWorkerBrief | null {
    const worker = VIRTUAL_OFFICE_WORKERS.find((w) => w.id === workerId);
    if (!worker) {
      return null;
    }
    const task =
      this.tasks.find((t) => t.workerId === workerId && t.status === 'running') ||
      this.tasks.find((t) => t.workerId === workerId) ||
      null;

    let deskStatus: VirtualOfficeWorkerBrief['deskStatus'] = 'idle';
    if (task?.status === 'running') {
      deskStatus = 'working';
    } else if (task?.status === 'completed') {
      deskStatus = 'done';
    } else if (task?.status === 'failed') {
      deskStatus = 'error';
    }

    return {
      workerId: worker.id,
      workerName: worker.name,
      role: worker.role,
      deskStatus,
      task,
    };
  }

  bindFrame(win: Window | null) {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = undefined;
    }
    this.frameWin = win;
    this.frameReady = false;
    if (!win) {
      return;
    }
    this.messageHandler = (ev: MessageEvent) => {
      const d = ev.data;
      if (!d || d.source !== 'officeai') {
        return;
      }
      if (d.type === 'ready') {
        this.frameReady = true;
        this.flushPendingAnim();
      } else if (d.type === 'worker-click' && d.detail?.workerId) {
        this.inspectWorker(String(d.detail.workerId));
      }
    };
    window.addEventListener('message', this.messageHandler);
    try {
      win.postMessage({ source: 'olkil-virtual-office', type: 'ping' }, '*');
    } catch {
      // ignore
    }
  }

  async assignFromChat(
    prompt: string,
    opts?: { modelId?: string; mode?: 'agent' | 'plan' | 'ask' },
  ): Promise<VirtualOfficeTask> {
    const text = (prompt || '').trim();
    if (!text) {
      throw new Error('Empty task');
    }

    const workspaceRoot = this.workspaceRoot();
    if (!workspaceRoot) {
      throw new Error('Open a project folder first (File → Open Folder), then assign Virtual Office work.');
    }

    const activeCount = this.tasks.filter((t) => t.status === 'running').length;
    if (activeCount >= MAX_VIRTUAL_OFFICE_PARALLEL) {
      throw new Error(`Virtual Office is at capacity (${MAX_VIRTUAL_OFFICE_PARALLEL} parallel agents).`);
    }

    let workerId: string;
    let workerName: string;
    let workerRole: string;

    if (this.assigneeId === 'manager') {
      const free = this.pickFreeWorker(text);
      if (!free) {
        throw new Error('All teammates are busy — wait for someone to finish, or pick someone free.');
      }
      workerId = free.id;
      workerName = free.name;
      workerRole = free.role;
    } else {
      const busy = [...this.workerTask.keys()].includes(this.assigneeId);
      if (busy) {
        const w = VIRTUAL_OFFICE_WORKERS.find((x) => x.id === this.assigneeId);
        throw new Error(`${w?.name || this.assigneeId} is already working — pick someone else or Manager.`);
      }
      const w = VIRTUAL_OFFICE_WORKERS.find((x) => x.id === this.assigneeId);
      if (!w) {
        throw new Error('Unknown teammate');
      }
      workerId = w.id;
      workerName = w.name;
      workerRole = w.role;
    }

    this.postToOffice({ type: 'assign', workerId, task: titleFromPrompt(text) });

    const now = Date.now();
    const task: VirtualOfficeTask = {
      id: nextTaskId(),
      workerId,
      workerName,
      title: titleFromPrompt(text),
      prompt: text,
      status: 'running',
      runId: nextRunId(),
      createdAt: now,
      updatedAt: now,
      liveStatus: 'Starting',
      activities: [{ id: 'kickoff', label: 'Assigned — starting', done: false }],
      files: [],
    };

    this.tasks = [task, ...this.tasks].slice(0, 60);
    this.workerTask.set(workerId, task.id);
    this.inspectedWorkerId = workerId;
    this.ensurePoll();
    this.fire();

    const enriched = buildVirtualOfficeAgentPrompt(workerName, workerRole, text);
    const activeFile = this.editorService.currentResource?.uri.codeUri.fsPath;
    const mode = opts?.mode || 'agent';
    const runId = task.runId;

    const promise = (async () => {
      try {
        await this.aiNode.clineRun({
          runId,
          prompt: enriched,
          workspaceRoot,
          activeFile,
          mode,
          modelId: opts?.modelId,
          autoApprove: mode === 'agent',
          conversationId: `vo:${task.id}`,
        });
      } catch (err: any) {
        this.finishTask(task.id, { status: 'failed', error: err?.message || String(err) });
      }
    })().finally(() => {
      this.runPromises.delete(runId);
      this.maybeStopPoll();
    });

    this.runPromises.set(runId, promise);
    return task;
  }

  beginLiveQa(goal: string): string | null {
    if (!this.active) {
      return null;
    }
    const title = titleFromPrompt(goal) || 'Live Test';
    this.assigneeId = 'jasmine';
    this.inspectedWorkerId = 'jasmine';
    this.postToOffice({ type: 'assign', workerId: 'jasmine', task: title });

    if (this.workerTask.has('jasmine')) {
      this.fire();
      return null;
    }

    const now = Date.now();
    const task: VirtualOfficeTask = {
      id: nextTaskId(),
      workerId: 'jasmine',
      workerName: 'Jasmine',
      title,
      prompt: goal,
      status: 'running',
      runId: `vo_live_${now}`,
      createdAt: now,
      updatedAt: now,
      liveStatus: 'Live Test',
      activities: [{ id: 'live-qa', label: 'Live browser test', done: false }],
      files: [],
      engine: 'live-test',
    };
    this.tasks = [task, ...this.tasks].slice(0, 60);
    this.workerTask.set('jasmine', task.id);
    this.fire();
    return task.id;
  }

  endLiveQa(
    taskId: string,
    result: { status: 'completed' | 'failed' | 'cancelled'; summary?: string },
  ) {
    this.finishTask(taskId, result);
  }

  completeWorker(workerId: string) {
    this.postToOffice({ type: 'complete', workerId });
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== 'running') {
      return;
    }
    try {
      await this.aiNode.clineCancel(task.runId);
    } catch {
      // ignore
    }
    this.finishTask(taskId, { status: 'cancelled' });
  }

  async stopAll(): Promise<void> {
    const open = this.tasks.filter((t) => t.status === 'running');
    await Promise.all(open.map((t) => this.cancelTask(t.id)));
  }

  private pickFreeWorker(taskLabel: string): (typeof VIRTUAL_OFFICE_WORKERS)[number] | null {
    const busy = new Set(this.workerTask.keys());
    const idle = VIRTUAL_OFFICE_WORKERS.filter((w) => !busy.has(w.id));
    if (!idle.length) {
      return null;
    }
    const lower = taskLabel.toLowerCase();
    const keywords: Record<string, string[]> = {
      alex: ['ui', 'frontend', 'react', 'css', 'page', 'component'],
      elon: ['data', 'model', 'ai', 'ml', 'analysis', 'pipeline', 'prompt'],
      sophia: ['design', 'ux', 'logo', 'brand', 'wireframe', 'figma'],
      robert: ['api', 'backend', 'server', 'database', 'auth', 'endpoint'],
      jasmine: ['bug', 'fix', 'test', 'qa', 'error', 'issue'],
    };
    let best = idle[0];
    let bestScore = -1;
    for (const w of idle) {
      const keys = keywords[w.id] || [];
      const score = keys.reduce((n, k) => n + (lower.includes(k) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = w;
      }
    }
    return best;
  }

  private postToOffice(msg: { type: string; workerId?: string; task?: string }) {
    if (!this.frameWin || !this.frameReady) {
      this.pendingAnim.push(msg);
      return;
    }
    try {
      this.frameWin.postMessage({ source: 'olkil-virtual-office', ...msg }, '*');
    } catch {
      this.pendingAnim.push(msg);
    }
  }

  private flushPendingAnim() {
    const q = this.pendingAnim.splice(0);
    for (const msg of q) {
      this.postToOffice(msg);
    }
  }

  private ensurePoll() {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => void this.pollRuns(), POLL_MS);
  }

  private maybeStopPoll() {
    if (this.tasks.some((t) => t.status === 'running' && t.engine !== 'live-test')) {
      return;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollRuns() {
    const running = this.tasks.filter((t) => t.status === 'running' && t.engine !== 'live-test');
    if (!running.length) {
      this.maybeStopPoll();
      return;
    }
    let changed = false;
    await Promise.all(
      running.map(async (task) => {
        try {
          const st = await this.aiNode.clineGetState(task.runId);
          const activities: VirtualOfficeLiveActivity[] = (st.activities || [])
            .slice(-MAX_ACTIVITIES)
            .map((a) => ({
              id: a.id,
              label: a.label,
              done: a.done,
              kind: a.kind,
              filePath: a.filePath,
            }));

          const files: VirtualOfficeLiveFile[] = [];
          const seen = new Set<string>();
          for (const fc of st.fileChanges || []) {
            const key = fc.path;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            files.push({ path: fc.path, kind: fc.kind });
          }
          for (const a of activities) {
            if (a.filePath && !seen.has(a.filePath)) {
              seen.add(a.filePath);
              files.push({ path: a.filePath, kind: 'touch' });
            }
          }

          const statusLabel = st.status || task.liveStatus || 'Working';
          const actChanged =
            activities.length !== task.activities.length ||
            activities.some(
              (a, i) => a.id !== task.activities[i]?.id || a.done !== task.activities[i]?.done,
            );
          const filesChanged =
            files.length !== task.files.length || files.some((f, i) => f.path !== task.files[i]?.path);

          if (actChanged || filesChanged || statusLabel !== task.liveStatus) {
            task.activities = activities.length ? activities : task.activities;
            task.files = files;
            task.liveStatus = statusLabel;
            task.updatedAt = Date.now();
            changed = true;
          }

          if (st.done) {
            if (st.error) {
              this.finishTask(task.id, {
                status: 'failed',
                error: st.error,
                summary: st.text,
              });
            } else {
              this.finishTask(task.id, {
                status: 'completed',
                summary: (st.text || '').slice(0, 4000),
              });
            }
            changed = true;
          }
        } catch {
          // transient
        }
      }),
    );
    if (changed) {
      this.fire();
    }
  }

  private finishTask(
    taskId: string,
    result: { status: VirtualOfficeTask['status']; summary?: string; error?: string },
  ) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== 'running') {
      return;
    }
    task.status = result.status;
    task.summary = result.summary ?? task.summary;
    task.error = result.error;
    task.updatedAt = Date.now();
    task.liveStatus = result.status === 'completed' ? 'Done' : result.status === 'failed' ? 'Failed' : 'Cancelled';
    if (task.activities.length) {
      task.activities[task.activities.length - 1].done = true;
    }
    this.workerTask.delete(task.workerId);
    this.completeWorker(task.workerId);
    this.fire();
    this.maybeStopPoll();
  }

  private fire(immediate = false) {
    if (immediate) {
      this.fireQueued = false;
      this._onDidChange.fire();
      return;
    }
    if (this.fireQueued) {
      return;
    }
    this.fireQueued = true;
    requestAnimationFrame(() => {
      this.fireQueued = false;
      this._onDidChange.fire();
    });
  }

  private workspaceRoot(): string {
    try {
      const roots = this.workspaceService?.tryGetRoots?.() || [];
      for (const root of roots) {
        const fsPath = new URI(root.uri).codeUri.fsPath;
        if (fsPath) {
          return fsPath;
        }
      }
      const ws = this.workspaceService?.workspace;
      if (ws?.uri) {
        const fsPath = new URI(ws.uri).codeUri.fsPath;
        if (fsPath && !/\.code-workspace$/i.test(fsPath)) {
          return fsPath;
        }
      }
    } catch {
      // fall through
    }
    return this.appConfig.workspaceDir || '';
  }

  dispose() {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.frameWin = null;
    super.dispose();
  }
}
