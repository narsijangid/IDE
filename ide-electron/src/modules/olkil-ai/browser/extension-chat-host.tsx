import React, { useEffect, useRef, useState } from 'react';
import { CommandService, useInjectable } from '@opensumi/ide-core-browser';
import { IElectronMainUIService } from '@opensumi/ide-core-common/lib/electron';
import { IOlkilAuthService } from '../../olkil-auth/common';
import { IOlkilSettingsService } from '../../olkil-auth/common/settings';
import { loadSubscription, OlkilSubscription, readCachedSubscription } from '../../olkil-auth/browser/account.view';
import { OLKIL_AUTH_OPEN_ACCOUNT } from '../../olkil-auth/browser/commands';
import { customModelCatalogId, findModel, isMeteredCloudProvider } from '../common/models';
import {
  ActivityInfo,
  ChatAttachment,
  FileChangeInfo,
  IOlkilAiNodeService,
  IOlkilChatService,
  OlkilAiNodeServicePath,
  UiChatMessage,
} from '../common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import { IdeRemote, sharedIdeRemote } from './ide-remote';
import {
  IOlkilVirtualOfficeService,
  VIRTUAL_OFFICE_ASSIGNEES,
  VIRTUAL_OFFICE_WORKERS,
  VirtualOfficeAssigneeId,
  VirtualOfficeLiveActivity,
  VirtualOfficeTask,
} from '../common/virtual-office';
import { OLKIL_VIRTUAL_OFFICE_TOGGLE } from './virtual-office.contribution';
import sidebarJs from '../../../../../packages/olkil-vscode/webview/sidebar.js';
import sidebarCss from '../../../../../packages/olkil-vscode/webview/sidebar.css';
import qrcodeJs from '../../../../../packages/olkil-vscode/webview/qrcode.js';
import logoUrl from '../../../browser/assets/olkil-icon.png';

type Post = (msg: Record<string, unknown>) => void;

/** Same plan cards the VS Code extension shows in its upgrade sheet. */
const PAID_PLANS = [
  { id: 'lite', name: 'Lite', price: '$10', period: '/ mo', blurb: 'Cloud agent and frontier models' },
  { id: 'pro', name: 'Pro', price: '$20', period: '/ mo', blurb: 'Extended limits on Agent', featured: true },
  { id: 'ultra', name: 'Ultra', price: '$100', period: '/ mo', blurb: 'Parallel agents and priority' },
];

/** VS Code dark theme tokens the extension webview CSS reads. */
const IDE_THEME_VARS: Record<string, string> = {
  '--vscode-sideBar-background': '#0a0a0a',
  '--vscode-editor-background': '#141414',
  '--vscode-foreground': 'rgba(255,255,255,.92)',
  '--vscode-descriptionForeground': 'rgba(255,255,255,.55)',
  '--vscode-widget-border': 'rgba(255,255,255,.1)',
  '--vscode-input-background': '#101010',
  '--vscode-font-family': '"Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  '--vscode-editor-font-family': 'ui-monospace, "Cascadia Code", Consolas, monospace',
  '--vscode-font-size': '13px',
};

const QUOTA_RE = /used up|plan_required|Buy (Lite|Pro|Ultra)|upgrade to|included cloud/i;
const ERROR_RE = /\b(error|failed|fail|could not|cannot|can't|unavailable|not configured|expired|denied|invalid)\b|first —|wait until/i;
const QUIET_STATUS_RE = /^(Model switched to |(Agent|Ask|Plan) mode — )/i;

/** Per-teammate bookkeeping so only changed Virtual Office steps reach the webview. */
interface VoTaskSeen {
  status: VirtualOfficeTask['status'];
  liveStatus: string;
  acts: Map<string, string>;
}

/**
 * The VS Code extension chat (sidebar.js) hosted inside the IDE panel.
 * Speaks the same message protocol as packages/olkil-vscode/src/sidebar.ts,
 * backed by the IDE chat, Virtual Office, auth and remote services.
 */
export const ExtensionChatHost = () => {
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const settings = useInjectable<IOlkilSettingsService>(IOlkilSettingsService);
  const office = useInjectable<IOlkilVirtualOfficeService>(IOlkilVirtualOfficeService);
  const aiNode = useInjectable<IOlkilAiNodeService>(OlkilAiNodeServicePath);
  const workspace = useInjectable<IWorkspaceService>(IWorkspaceService);
  const commands = useInjectable<CommandService>(CommandService);
  const electronUi = useInjectable<IElectronMainUIService>(IElectronMainUIService);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const remoteRef = useRef<IdeRemote | null>(null);
  const [srcDoc, setSrcDoc] = useState('');

  useEffect(() => {
    const post: Post = (msg) => {
      frameRef.current?.contentWindow?.postMessage(msg, '*');
    };

    // Main-chat transcript mirror.
    const sent = new Map<string, string>();
    const fileSigs = new Map<string, string>();
    let order: string[] = [];
    /** Whether the webview currently believes the main chat is running (shows Stop). */
    let uiBusy = false;
    /** A send from the webview is in flight; idle must wait for it. */
    let sending = false;
    /** The webview already drew this turn's user bubble (skipUserEcho). */
    let echoPending = false;
    let lastPhase = '';
    let ollamaSig = '';
    let authSig = '';
    let quota: Record<string, unknown> | null = null;

    // Virtual Office mirror.
    const voSeen = new Map<string, VoTaskSeen>();
    const voLog = new Map<string, Array<Record<string, unknown>>>();
    let voActive = office.active;
    let voInspected = office.inspectedWorkerId;

    let permissionSig = '';

    const resetMirror = () => {
      sent.clear();
      fileSigs.clear();
      order = [];
      uiBusy = false;
      lastPhase = '';
      ollamaSig = '';
      permissionSig = '';
    };

    const syncPermission = () => {
      const pending = chat.pendingPermission;
      const sig = pending ? `${pending.id}:${pending.queued}` : '';
      if (sig === permissionSig) {
        return;
      }
      const sameRequest = Boolean(pending) && permissionSig.split(':')[0] === pending!.id;
      permissionSig = sig;
      if (!sameRequest) {
        post({ type: 'permissionClear', all: true });
      }
      if (pending) {
        post({
          type: 'permission',
          id: pending.id,
          kind: pending.kind,
          detail: pending.detail,
          gate: pending.gate,
          always: pending.always,
          queued: pending.queued,
        });
      }
    };

    const customsForUi = () =>
      (settings.get().customModels || []).map((item) => ({
        id: String(item.id || '').replace(/^custom:/, ''),
        model: item.model,
        baseUrl: item.baseUrl,
        hasKey: Boolean(item.apiKey),
        label: item.label,
      }));

    const voRunning = () => {
      const latest = new Map<string, VirtualOfficeTask>();
      for (const task of office.tasks) {
        if (!latest.has(task.workerId)) {
          latest.set(task.workerId, task);
        }
      }
      return [...latest.values()].map((task) => ({
        workerId: task.workerId,
        workerName: task.workerName,
        title: task.title,
        status: task.status === 'running' ? 'running' : task.status === 'completed' ? 'done' : 'failed',
      }));
    };

    const pushAuth = () => {
      const user = auth.getSession()?.user;
      authSig = authSignature(chat);
      post({
        type: 'auth',
        signedIn: auth.isSignedIn(),
        user: user ? { displayName: user.displayName || '', email: user.email || '', uid: user.uid || '' } : null,
        quota,
        engineReady: true,
        paid: !chat.deepseekLocked,
        chatOpen: true,
        plans: PAID_PLANS,
        models: chat.models.map((model) => ({ id: model.id, label: model.label })),
        modelId: chat.modelId,
        customs: customsForUi(),
        virtualOffice: office.active,
        voAssignee: office.assigneeId,
        voAssignees: VIRTUAL_OFFICE_ASSIGNEES.map((person) => ({
          id: person.id,
          name: person.name,
          role: person.id === 'manager' ? 'Auto-assign' : person.role,
        })),
        voInspected: office.inspectedWorkerId || '',
        voRunning: voRunning(),
        remoteAccess: Boolean(remoteRef.current?.isOn()),
        defaultMode: settings.get().defaultChatMode === 'ask' ? 'ask' : 'agent',
      });
    };

    const refreshQuota = async () => {
      const email = auth.getSession()?.user?.email;
      if (!email || !auth.isSignedIn()) {
        quota = null;
        pushAuth();
        return;
      }
      const cached = readCachedSubscription(email);
      if (cached) {
        quota = quotaFromSubscription(cached);
        pushAuth();
      }
      const fresh = await loadSubscription(email);
      if (fresh) {
        quota = quotaFromSubscription(fresh);
        pushAuth();
      }
    };

    const markBusy = () => {
      uiBusy = true;
    };

    const emitStatus = (text: string, live: boolean) => {
      const body = String(text || '').trim();
      if (!body || QUIET_STATUS_RE.test(body)) {
        return;
      }
      if (QUOTA_RE.test(body)) {
        if (live) {
          post({ type: 'upgrade', reason: '' });
        } else {
          post({ type: 'error', text: body });
        }
        return;
      }
      if (ERROR_RE.test(body)) {
        post({ type: 'error', text: body });
        return;
      }
      post({ type: 'activity', id: `status:${hashText(body)}`, label: body, kind: 'info', done: true });
      markBusy();
    };

    const emitMessage = (message: UiChatMessage, live: boolean) => {
      if (message.role === 'user') {
        if (live && echoPending) {
          echoPending = false;
        } else {
          post({ type: 'user', text: userText(message) });
        }
        markBusy();
        return;
      }
      if (message.role === 'assistant') {
        post({ type: 'assistant', text: message.content, live: Boolean(message.pending) });
        markBusy();
        return;
      }
      if (message.role === 'activity' && message.activity) {
        post({ type: 'activity', id: message.id, ...activityPayload(message.activity) });
        markBusy();
        return;
      }
      if (message.role === 'status') {
        emitStatus(message.content, live);
      }
    };

    const syncOllama = () => {
      const dl = chat.ollamaDownload;
      if (!dl || dl.phase === 'idle') {
        return;
      }
      const sig = `${dl.phase}:${Math.round(dl.percent || 0)}:${dl.modelId || ''}`;
      if (sig === ollamaSig) {
        return;
      }
      const wasActive = Boolean(ollamaSig) && !/^(ready|needs_download)/.test(ollamaSig);
      ollamaSig = sig;
      const name = dl.label || dl.model || 'local model';
      if (dl.phase === 'downloading' || dl.phase === 'starting') {
        post({
          type: 'activity',
          id: 'ollama-download',
          label: `Downloading ${name} · ${Math.round(dl.percent || 0)}%`,
          kind: 'info',
          done: false,
        });
        markBusy();
      } else if (dl.phase === 'paused') {
        post({ type: 'activity', id: 'ollama-download', label: `${name} download paused`, kind: 'info', done: true });
        markBusy();
      } else if (dl.phase === 'error') {
        post({ type: 'error', text: dl.error || dl.message || `Could not download ${name}.` });
      } else if (dl.phase === 'ready' && wasActive) {
        post({ type: 'activity', id: 'ollama-download', label: `${name} ready`, kind: 'info', done: true });
        markBusy();
      }
    };

    const syncTranscript = () => {
      const messages = chat.messages;
      const ids = messages.map((message) => message.id);
      const prefixOk = order.length <= ids.length && order.every((id, index) => ids[index] === id);
      if (!prefixOk) {
        post({ type: 'reset' });
        resetMirror();
      }
      const live = order.length > 0;

      let segment = 'start';
      let segmentFiles: FileChangeInfo[] = [];
      const flushFiles = (isLast: boolean) => {
        if (!segmentFiles.length) {
          return;
        }
        const streaming = isLast && chat.busy;
        const sig =
          segmentFiles.map((file) => `${file.id}:${file.status}:${file.additions}:${file.deletions}`).join('|') +
          (streaming ? ':live' : '');
        const prev = fileSigs.get(segment);
        if (prev === sig) {
          return;
        }
        fileSigs.set(segment, sig);
        // The webview attaches a files card to its latest turn, so older turns only render on replay.
        if (prev !== undefined && !isLast) {
          return;
        }
        post({ type: 'files', files: segmentFiles.map((file) => filePayload(file, streaming)) });
      };

      for (const message of messages) {
        if (message.role === 'user') {
          flushFiles(false);
          segment = message.id;
          segmentFiles = [];
        }
        if (message.role === 'file_change') {
          if (message.fileChange) {
            segmentFiles.push(message.fileChange);
          }
          continue;
        }
        if (message.role === 'todos' || message.role === 'system') {
          continue;
        }
        if (message.role === 'assistant' && !message.content.trim()) {
          continue;
        }
        const nextSig = messageSignature(message);
        if (sent.get(message.id) === nextSig) {
          continue;
        }
        emitMessage(message, live);
        sent.set(message.id, nextSig);
      }
      flushFiles(true);
      syncOllama();

      if (chat.busy) {
        const phase = chat.status || 'Planning next moves';
        if (phase !== lastPhase) {
          lastPhase = phase;
          post({ type: 'phase', label: phase });
        }
        uiBusy = true;
      } else if (uiBusy && !sending) {
        post({ type: 'idle' });
        uiBusy = false;
        lastPhase = '';
      }
      order = ids;

      if (authSignature(chat) !== authSig) {
        pushAuth();
      }
    };

    // ---------- Virtual Office ----------

    const postVo = (workerId: string, msg: Record<string, unknown>) => {
      const payload = { ...msg, voWorkerId: workerId };
      post(payload);
      const log = voLog.get(workerId) || [];
      log.push(payload);
      if (log.length > 400) {
        log.splice(0, log.length - 400);
      }
      voLog.set(workerId, log);
    };

    const pushVoStatus = () => {
      post({
        type: 'voStatus',
        virtualOffice: office.active,
        voAssignee: office.assigneeId,
        voInspected: office.inspectedWorkerId || '',
        voRunning: voRunning(),
      });
    };

    const postVoParallel = () => {
      const still = office.tasks.filter((task) => task.status === 'running').length;
      post({
        type: 'voParallel',
        label:
          still > 0
            ? `${still} teammate${still === 1 ? '' : 's'} still working — send another task anytime`
            : 'All free — send the next task',
      });
    };

    const showVoWorkerChat = (workerId: string) => {
      const worker = VIRTUAL_OFFICE_WORKERS.find((item) => item.id === workerId);
      const task = office.tasks.find((item) => item.workerId === workerId);
      const name = task?.workerName || worker?.name || workerId;
      post({
        type: 'voOpenChat',
        workerId,
        workerName: name,
        fresh: false,
        messages: voLog.get(workerId) || [],
        phase:
          task?.status === 'running'
            ? `${name} working`
            : task
              ? `${name} · ${task.status === 'completed' ? 'done' : task.status}`
              : `${name} · idle`,
      });
      pushVoStatus();
    };

    const finishVoTask = (task: VirtualOfficeTask) => {
      const wid = task.workerId;
      if (task.status === 'completed') {
        const summary = (task.summary || '').trim() || 'Done. Finished the assigned task.';
        postVo(wid, { type: 'assistant', text: summary, live: false });
        postVo(wid, {
          type: 'activity',
          id: `vo-done-${task.id}`,
          label: `${task.workerName} finished`,
          detail: task.title,
          done: true,
        });
      } else if (task.status === 'cancelled') {
        postVo(wid, {
          type: 'activity',
          id: `vo-stop-${task.id}`,
          label: `${task.workerName} stopped`,
          detail: task.title,
          done: true,
        });
      } else {
        postVo(wid, { type: 'error', text: task.error || `${task.workerName} could not finish this task.` });
      }
      postVo(wid, { type: 'phase', label: '' });
      post({ type: 'voWorkerDone', workerId: wid, voRunning: voRunning() });
      post({ type: 'idle', voWorkerId: wid });
      postVoParallel();
    };

    const syncVoTask = (task: VirtualOfficeTask) => {
      let seen = voSeen.get(task.id);
      if (!seen) {
        if (task.status !== 'running') {
          voSeen.set(task.id, { status: task.status, liveStatus: task.liveStatus || '', acts: new Map() });
          return;
        }
        seen = { status: 'running', liveStatus: '', acts: new Map() };
        voSeen.set(task.id, seen);
      }
      const wid = task.workerId;
      for (const act of task.activities) {
        if (act.id === 'kickoff') {
          continue;
        }
        const sig = `${act.label}\u0001${act.done ? 1 : 0}\u0001${act.filePath || ''}`;
        if (seen.acts.get(act.id) === sig) {
          continue;
        }
        seen.acts.set(act.id, sig);
        postVo(wid, { type: 'activity', id: `vo:${task.id}:${act.id}`, ...voActivityPayload(act) });
      }
      const liveStatus = task.liveStatus || '';
      if (task.status === 'running' && liveStatus && liveStatus !== seen.liveStatus) {
        seen.liveStatus = liveStatus;
        const label = /^(starting|working)$/i.test(liveStatus)
          ? `${task.workerName} working`
          : `${task.workerName} · ${liveStatus}`;
        postVo(wid, { type: 'phase', label });
      }
      if (seen.status === 'running' && task.status !== 'running') {
        seen.status = task.status;
        finishVoTask(task);
      }
    };

    const syncOffice = () => {
      for (const task of [...office.tasks].reverse()) {
        syncVoTask(task);
      }
      const nextInspected = office.inspectedWorkerId;
      if (office.active && nextInspected && nextInspected !== voInspected) {
        voInspected = nextInspected;
        showVoWorkerChat(nextInspected);
      } else {
        voInspected = nextInspected;
      }
      if (office.active !== voActive) {
        voActive = office.active;
        pushAuth();
        if (!voActive) {
          // Leaving the office: show the main thread again.
          post({ type: 'reset' });
          resetMirror();
          syncTranscript();
        }
        return;
      }
      pushVoStatus();
    };

    const assignVirtualOffice = async (text: string) => {
      const option = findModel(chat.modelId);
      if (isMeteredCloudProvider(option.provider) && chat.deepseekLocked) {
        post({ type: 'upgrade', reason: '' });
        return;
      }
      try {
        const task = await office.assignFromChat(text, { modelId: chat.modelId, mode: 'agent' });
        voSeen.set(task.id, { status: 'running', liveStatus: task.liveStatus || '', acts: new Map() });
        voLog.set(task.workerId, []);
        voInspected = task.workerId;
        post({
          type: 'voOpenChat',
          workerId: task.workerId,
          workerName: task.workerName,
          fresh: true,
          prompt: text,
        });
        voLog.get(task.workerId)!.push({ type: 'user', text, voWorkerId: task.workerId });
        postVo(task.workerId, {
          type: 'activity',
          id: `vo-assign-${task.id}`,
          label: `Assigned to ${task.workerName}`,
          detail: task.title,
          done: true,
        });
        postVo(task.workerId, { type: 'phase', label: `${task.workerName} working` });
        pushVoStatus();
        post({ type: 'voParallel', label: `${task.workerName} on it — send another task anytime` });
      } catch (err: any) {
        post({ type: 'error', text: err?.message || String(err) });
        post({ type: 'idle' });
      }
    };

    // ---------- Webview → host ----------

    const saveCustom = (rawId: string, model: string, baseUrl: string, apiKey: string) => {
      const current = settings.get().customModels || [];
      const id = rawId.replace(/^custom:/, '') || `c${Date.now().toString(36)}`;
      const existing = current.find((item) => String(item.id).replace(/^custom:/, '') === id);
      const key = apiKey || existing?.apiKey || '';
      if (!model || !baseUrl || !key) {
        post({ type: 'error', text: 'Add model id, base URL, and API key, then save.' });
        return;
      }
      const next = existing
        ? current.map((item) =>
            item === existing ? { ...item, model, baseUrl, apiKey: key, label: model, updatedAt: Date.now() } : item,
          )
        : [...current, { id, label: model, model, baseUrl, apiKey: key, enabled: true, updatedAt: Date.now() }];
      settings.patch({ customModels: next });
      window.setTimeout(() => {
        chat.setModel(customModelCatalogId(existing ? String(existing.id) : id));
        pushAuth();
      }, 0);
    };

    const send = async (msg: WebviewMessage) => {
      const text = String(msg.text || '').trim();
      const images = imageAttachments(msg.images);
      if (!text && !images.length) {
        post({ type: 'idle' });
        return;
      }
      if (office.active) {
        await assignVirtualOffice(text);
        return;
      }
      const option = findModel(chat.modelId);
      if (option.provider === 'ollama' && /^(needs_download|error)$/.test(chat.ollamaDownload.phase)) {
        void chat.startOllamaDownload();
        post({
          type: 'error',
          text: `Downloading ${option.label} for offline use — send again when it reaches 100%.`,
        });
        post({ type: 'idle' });
        return;
      }
      const mode = msg.mode === 'ask' ? 'ask' : 'agent';
      if (chat.chatMode !== mode) {
        chat.setChatMode(mode);
      }
      sending = true;
      uiBusy = true;
      echoPending = Boolean(msg.skipUserEcho);
      try {
        await chat.send(text, images);
      } catch (err: any) {
        post({ type: 'error', text: err?.message || String(err) });
      } finally {
        sending = false;
        echoPending = false;
        syncTranscript();
      }
    };

    const onWebviewMessage = async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          resetMirror();
          void chat.init();
          pushAuth();
          syncTranscript();
          syncPermission();
          void refreshQuota();
          if (office.active && office.inspectedWorkerId) {
            showVoWorkerChat(office.inspectedWorkerId);
          }
          break;
        case 'signIn':
          try {
            await auth.signIn();
          } catch (err: any) {
            const text = err?.message || String(err);
            if (!/login cancelled/i.test(text)) {
              post({ type: 'error', text });
            }
          }
          pushAuth();
          void refreshQuota();
          break;
        case 'signOut':
          await auth.signOut();
          pushAuth();
          break;
        case 'send':
          await send(msg);
          break;
        case 'abort':
          chat.stop();
          break;
        case 'abortVo': {
          const workerId = String(msg.workerId || '');
          const task = office.tasks.find((item) => item.workerId === workerId && item.status === 'running');
          if (task) {
            await office.cancelTask(task.id);
          }
          break;
        }
        case 'newChat':
          chat.newChat();
          break;
        case 'setModel': {
          const modelId = String(msg.modelId || '');
          if (modelId && modelId !== 'custom') {
            chat.setModel(modelId);
            const option = findModel(modelId);
            if (option.provider === 'ollama' && chat.ollamaDownload.phase === 'needs_download') {
              void chat.startOllamaDownload();
            }
          }
          pushAuth();
          break;
        }
        case 'saveCustom':
          saveCustom(
            String(msg.id || ''),
            String(msg.model || '').trim(),
            String(msg.baseUrl || '').trim(),
            String(msg.apiKey || '').trim(),
          );
          break;
        case 'deleteCustom': {
          const id = String(msg.id || '').replace(/^custom:/, '');
          const remaining = (settings.get().customModels || []).filter(
            (item) => String(item.id).replace(/^custom:/, '') !== id,
          );
          settings.patch({ customModels: remaining });
          if (chat.modelId === customModelCatalogId(id)) {
            chat.setModel(remaining[0] ? customModelCatalogId(String(remaining[0].id)) : 'auto');
          }
          pushAuth();
          break;
        }
        case 'listContextFiles': {
          const files = await chat.listMentionCandidates('', 60);
          post({
            type: 'contextFiles',
            files: files.map((file) => ({
              path: file.path,
              name: file.name,
              kind: file.kind === 'folder' ? 'folder' : 'workspace',
            })),
          });
          break;
        }
        case 'openFile':
          if (msg.path) {
            void chat.openPath(String(msg.path));
          }
          break;
        case 'acceptAll':
          await chat.acceptAllPending();
          break;
        case 'revertAll':
          await chat.revertAllPending();
          break;
        case 'acceptFile':
        case 'revertFile': {
          const target = String(msg.path || '');
          const change = chat.pendingChanges.find((item) => item.path === target || item.displayName === target);
          if (change) {
            await (msg.type === 'acceptFile' ? chat.acceptChange(change.id) : chat.revertChange(change.id));
          }
          break;
        }
        case 'toggleVirtualOffice':
          await commands.executeCommand(OLKIL_VIRTUAL_OFFICE_TOGGLE.id);
          pushAuth();
          break;
        case 'permissionReply': {
          const response = msg.response === 'always' || msg.response === 'reject' ? msg.response : 'once';
          await chat.replyPermission(String(msg.id || ''), response);
          break;
        }
        case 'openSettings':
          await commands.executeCommand(OLKIL_AUTH_OPEN_ACCOUNT.id);
          break;
        case 'setVoAssignee':
          if (isAssigneeId(msg.id)) {
            office.setAssignee(msg.id);
          }
          break;
        case 'openPlan':
          electronUi.openExternal(
            'https://olkil.com/checkout/?plan=' + encodeURIComponent(String(msg.plan || 'pro')),
          );
          break;
        case 'toggleRemoteAccess': {
          const remote = remoteRef.current;
          if (!remote) {
            break;
          }
          const on = await remote.toggle();
          pushAuth();
          const url = remote.qrUrl();
          post({ type: 'remoteQr', open: on && Boolean(url), url });
          if (!on && remote.lastError) {
            post({ type: 'error', text: remote.lastError });
          }
          break;
        }
        case 'showRemoteQr': {
          const remote = remoteRef.current;
          if (!remote) {
            break;
          }
          if (!remote.isOn()) {
            await remote.start();
          }
          pushAuth();
          const url = remote.qrUrl();
          if (url) {
            post({ type: 'remoteQr', open: true, url });
          }
          break;
        }
        default:
          break;
      }
    };

    const remote = sharedIdeRemote({
      getToken: () => auth.getValidIdToken(),
      getUid: () => auth.getSession()?.user?.uid || '',
      agentBusy: () => chat.busy,
      ask: async (text, mode) => {
        chat.setChatMode(mode);
        await chat.send(text);
      },
      abort: () => chat.stop(),
      acceptAll: () => chat.acceptAllPending(),
      revertAll: () => chat.revertAllPending(),
      setModel: (modelId) => chat.setModel(modelId),
      getModel: () => chat.modelId,
      listModels: () => chat.models.map((model) => ({ id: model.id, label: model.label })),
      workspaceName: () => {
        const roots = workspace.tryGetRoots?.() || [];
        const uri = String(roots[0]?.uri || '');
        return uri.split(/[/\\]/).filter(Boolean).pop() || '';
      },
      setAwake: (on) => aiNode.setKeepAwake(on),
      saveCustom: async (model, baseUrl, apiKey) => saveCustom('', model, baseUrl, apiKey),
      watchChat: (sink) => chat.onDidChange(() => feedRemote(chat, sink, remoteFeed)),
      onChange: () => pushAuth(),
    });
    remoteRef.current = remote;

    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) {
        return;
      }
      void onWebviewMessage((event.data || {}) as WebviewMessage).catch((err) => {
        post({ type: 'error', text: err?.message || String(err) });
      });
    };
    const onWallet = () => void refreshQuota();

    window.addEventListener('message', onMessage);
    window.addEventListener('olkil-wallet-updated', onWallet);
    setSrcDoc(buildSrcDoc(String(logoUrl)));
    const chatSub = chat.onDidChange(() => {
      syncTranscript();
      syncPermission();
    });
    const authSub = auth.onDidChangeSession(() => {
      pushAuth();
      void refreshQuota();
    });
    const officeSub = office.onDidChange(() => syncOffice());
    const settingsSub = settings.onDidChange(() => pushAuth());
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('olkil-wallet-updated', onWallet);
      chatSub.dispose();
      authSub.dispose();
      officeSub.dispose();
      settingsSub.dispose();
    };
    // The host is created once with the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <iframe
      ref={frameRef}
      className="olkil-extension-chat"
      title="OLKIL chat"
      srcDoc={srcDoc}
      style={{ flex: 1, width: '100%', height: '100%', border: 0, background: '#0a0a0a' }}
    />
  );
};

interface WebviewMessage {
  type?: string;
  text?: string;
  mode?: string;
  modelId?: string;
  path?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  id?: string;
  plan?: string;
  workerId?: string;
  response?: string;
  skipUserEcho?: boolean;
  images?: Array<{ name?: string; mime?: string; dataUrl?: string }>;
}

function authSignature(chat: IOlkilChatService): string {
  return [chat.modelId, chat.models.length, chat.models[chat.models.length - 1]?.id || '', chat.deepseekLocked ? 1 : 0].join(
    '|',
  );
}

function quotaFromSubscription(sub: OlkilSubscription): Record<string, unknown> {
  return {
    plan: sub.plan,
    planName: sub.plan_name,
    percentLeft: Number(sub.percent_left) || 0,
    isPaid: Boolean(sub.is_paid),
    upgradeUrl: sub.upgrade_url || 'https://olkil.com/pricing/',
  };
}

function imageAttachments(raw: WebviewMessage['images']): ChatAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((img) => img && typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/'))
    .slice(0, 6)
    .map((img, index) => {
      const name = String(img.name || `image-${index + 1}.png`);
      return { path: name, name, kind: 'image' as const, dataUrl: img.dataUrl, mimeType: img.mime || 'image/png' };
    });
}

/** The chat service appends `@name` for attachments; image previews already show in the bubble. */
function userText(message: UiChatMessage): string {
  let text = message.content || '';
  for (const attachment of message.attachments || []) {
    if (attachment.kind === 'image') {
      text = text.split(`@${attachment.name}`).join('');
    }
  }
  return text.trim() || (message.attachments?.length ? '' : message.content);
}

function messageSignature(message: UiChatMessage): string {
  const activity = message.activity;
  return [
    message.role,
    message.content,
    message.pending ? '1' : '0',
    activity?.label || '',
    activity?.done ? '1' : '0',
    activity?.filePath || '',
    activity?.detail || '',
  ].join('\u0001');
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Maps IDE activity kinds onto the kinds sidebar.js groups and animates. */
function webviewKind(kind: string, label: string): string {
  switch (kind) {
    case 'editing':
      return /^(creat|new file|wrote|writ)/i.test(label) ? 'create' : 'edit';
    case 'reading':
      return 'read';
    case 'searching':
    case 'indexing':
      return 'search';
    case 'running':
      return 'bash';
    case 'browsing':
      return 'web';
    case 'thinking':
      return 'status';
    case 'todo':
      return 'todo';
    default:
      return kind === 'edit' || kind === 'read' || kind === 'search' || kind === 'bash' ? kind : 'info';
  }
}

function activityPayload(activity: ActivityInfo): Record<string, unknown> {
  const file = activity.filePath || '';
  const kind = webviewKind(activity.kind, activity.label);
  const command = activity.command || (kind === 'bash' ? activity.detail || '' : '');
  return {
    label: activity.label,
    detail: activity.detail || file,
    file,
    command,
    kind,
    title: baseName(file) || undefined,
    done: Boolean(activity.done),
  };
}

function voActivityPayload(activity: VirtualOfficeLiveActivity): Record<string, unknown> {
  const file = activity.filePath || '';
  const kind = webviewKind(String(activity.kind || ''), activity.label);
  return {
    label: activity.label,
    detail: file,
    file,
    kind,
    title: baseName(file) || undefined,
    done: Boolean(activity.done),
  };
}

function filePayload(file: FileChangeInfo, live: boolean): Record<string, unknown> {
  return {
    path: file.path,
    name: file.displayName,
    additions: file.additions,
    deletions: file.deletions,
    status: file.status,
    action: file.kind === 'create' ? 'create' : file.kind === 'delete' ? 'delete' : 'edit',
    preview: (file.preview || []).slice(0, 12).map((line) => ({ type: line.type, text: line.text })),
    live,
  };
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

const remoteFeed = {
  sent: new Map<string, string>(),
  order: [] as string[],
  filesSig: '',
  busy: false,
};

function feedRemote(
  chat: IOlkilChatService,
  sink: (msg: Record<string, unknown>) => void,
  state: typeof remoteFeed,
) {
  const messages = chat.messages;
  const ids = messages.map((message) => message.id);
  const prefixOk = state.order.every((id, index) => ids[index] === id);
  if (!prefixOk) {
    sink({ type: 'reset' });
    state.sent.clear();
    state.filesSig = '';
  }
  for (const message of messages) {
    if (message.role === 'file_change' || message.role === 'todos') continue;
    const nextSig = messageSignature(message);
    if (state.sent.get(message.id) === nextSig) continue;
    if (message.role === 'user') sink({ type: 'user', text: message.content });
    else if (message.role === 'assistant') {
      sink({ type: 'assistant', text: message.content, live: Boolean(message.pending) });
    } else if (message.role === 'activity' && message.activity) {
      sink({
        type: 'activity',
        id: message.id,
        label: message.activity.label,
        done: Boolean(message.activity.done),
      });
    } else if (message.role === 'status' && message.content) {
      sink({ type: 'phase', label: message.content });
    }
    state.sent.set(message.id, nextSig);
  }
  const files = messages
    .filter((message) => message.role === 'file_change' && message.fileChange)
    .map((message) => message.fileChange!);
  const filesSig = files.map((file) => `${file.id}:${file.status}:${file.additions}:${file.deletions}`).join('|');
  if (filesSig !== state.filesSig) {
    state.filesSig = filesSig;
    if (files.length) {
      sink({
        type: 'files',
        files: files.map((file) => ({
          path: file.path,
          name: file.displayName,
          additions: file.additions,
          deletions: file.deletions,
          status: file.status,
        })),
      });
    }
  }
  if (state.busy && !chat.busy) sink({ type: 'idle' });
  else if (chat.busy && chat.status) sink({ type: 'phase', label: chat.status });
  state.busy = chat.busy;
  state.order = ids;
}

type Rgba = [number, number, number, number];

const NAMED_COLORS: Record<string, Rgba> = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  transparent: [0, 0, 0, 0],
};

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function readCustomProperties(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /(--[\w-]+)\s*:\s*([^;}]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    if (!(match[1] in vars)) {
      vars[match[1]] = match[2].trim();
    }
  }
  return vars;
}

function parseColor(token: string, vars: Record<string, string>, depth = 0): Rgba | null {
  const value = token.trim();
  if (depth > 8) {
    return null;
  }
  if (value.startsWith('var(') && value.endsWith(')')) {
    const [name, fallback] = splitTopLevel(value.slice(4, -1));
    const resolved = vars[name] ?? fallback;
    return resolved ? parseColor(resolved, vars, depth + 1) : null;
  }
  if (value.startsWith('color-mix(') && value.endsWith(')')) {
    return mixColors(value.slice('color-mix('.length, -1), vars, depth + 1);
  }
  if (NAMED_COLORS[value.toLowerCase()]) {
    return NAMED_COLORS[value.toLowerCase()];
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .split('')
        .map((d) => d + d)
        .join('');
    }
    if (digits.length !== 6 && digits.length !== 8) {
      return null;
    }
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), digits.length === 8 ? n(6) / 255 : 1];
  }
  const rgb = /^rgba?\(([^)]*)\)$/i.exec(value);
  if (rgb) {
    const nums = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (nums.length < 3) {
      return null;
    }
    const alphaRaw = nums[3];
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
    return [parseFloat(nums[0]), parseFloat(nums[1]), parseFloat(nums[2]), alpha];
  }
  return null;
}

/** color-mix(in srgb, A p%, B q%) with CSS Color 5 percentage normalisation and premultiplied alpha. */
function mixColors(args: string, vars: Record<string, string>, depth: number): Rgba | null {
  const parts = splitTopLevel(args);
  if (parts.length !== 3 || !/^in\s+srgb$/i.test(parts[0])) {
    return null;
  }
  const stops = parts.slice(1).map((part) => {
    const match = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part)!;
    return { color: parseColor(match[1], vars, depth), pct: match[2] === undefined ? undefined : parseFloat(match[2]) };
  });
  const [a, b] = stops;
  if (!a.color || !b.color) {
    return null;
  }
  let p = a.pct;
  let q = b.pct;
  if (p === undefined && q === undefined) {
    p = q = 50;
  } else if (p === undefined) {
    p = 100 - q!;
  } else if (q === undefined) {
    q = 100 - p;
  }
  const sum = p + q!;
  if (sum <= 0) {
    return null;
  }
  const alphaScale = sum < 100 ? sum / 100 : 1;
  const wa = p / sum;
  const wb = q! / sum;
  const alpha = a.color[3] * wa + b.color[3] * wb;
  if (alpha === 0) {
    return [0, 0, 0, 0];
  }
  const channel = (i: number) => (a.color![i] * a.color![3] * wa + b.color![i] * b.color![3] * wb) / alpha;
  return [channel(0), channel(1), channel(2), alpha * alphaScale];
}

/** Electron's Chromium predates CSS color-mix(), so resolve every mix to a flat rgba(). */
function downlevelColorMix(css: string, themeVars: Record<string, string>): string {
  const vars = { ...readCustomProperties(css), ...themeVars };
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = css.indexOf('color-mix(', cursor);
    if (start < 0) {
      break;
    }
    let depth = 0;
    let end = start + 'color-mix'.length;
    for (; end < css.length; end++) {
      if (css[end] === '(') {
        depth++;
      } else if (css[end] === ')' && --depth === 0) {
        break;
      }
    }
    const color = mixColors(css.slice(start + 'color-mix('.length, end), vars, 0);
    out += css.slice(cursor, start);
    out += color
      ? `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${Number(color[3].toFixed(3))})`
      : css.slice(start, end + 1);
    cursor = end + 1;
  }
  return out + css.slice(cursor);
}

const IDE_SIDEBAR_CSS = downlevelColorMix(String(sidebarCss), IDE_THEME_VARS);

function scriptText(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

function buildSrcDoc(icon: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    :root {
${Object.entries(IDE_THEME_VARS)
  .map(([name, value]) => `      ${name}: ${value};`)
  .join('\n')}
    }
    /* VS Code injects these defaults into every webview; sidebar.css is tuned against them. */
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: normal;
      color: var(--vscode-foreground);
      -webkit-font-smoothing: antialiased;
    }
    button, input, select, textarea { font-family: inherit; font-size: inherit; }
    a, a code { color: #4daafc; }
    code {
      font-family: var(--vscode-editor-font-family);
      color: #d7ba7d;
      background-color: rgba(255,255,255,.06);
      padding: 1px 3px;
      border-radius: 4px;
    }
    pre code { padding: 0; background: transparent; color: inherit; }
    img, video { max-width: 100%; max-height: 100%; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-corner { background-color: transparent; }
    ::-webkit-scrollbar-thumb { background-color: rgba(121,121,121,.4); border: 2px solid transparent; background-clip: content-box; border-radius: 6px; }
    ::-webkit-scrollbar-thumb:hover { background-color: rgba(100,100,100,.7); }
    ::-webkit-scrollbar-thumb:active { background-color: rgba(191,191,191,.4); }
  </style>
  <style>${IDE_SIDEBAR_CSS}</style>
  <style>.top img, .top .brand { display: none; }</style>
</head>
<body>
  <div id="app" data-icon="${icon}"></div>
  <script>
    function acquireVsCodeApi() {
      return {
        postMessage: function (msg) { parent.postMessage(msg, '*'); },
        getState: function () { return {}; },
        setState: function () {}
      };
    }
  </script>
  <script>${scriptText(String(qrcodeJs))}</script>
  <script>${scriptText(String(sidebarJs))}</script>
</body>
</html>`;
}

function isAssigneeId(value: string | undefined): value is VirtualOfficeAssigneeId {
  return VIRTUAL_OFFICE_ASSIGNEES.some((person) => person.id === value);
}
