import React, { useEffect, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { IOlkilAuthService } from '../../olkil-auth/common';
import { IOlkilSettingsService } from '../../olkil-auth/common/settings';
import { customModelCatalogId } from '../common/models';
import {
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
  VirtualOfficeAssigneeId,
} from '../common/virtual-office';
import sidebarJs from '../../../../../packages/olkil-vscode/webview/sidebar.js';
import sidebarCss from '../../../../../packages/olkil-vscode/webview/sidebar.css';
import qrcodeJs from '../../../../../packages/olkil-vscode/webview/qrcode.js';
import logoUrl from './olkil-logo.png';

/**
 * The VS Code extension chat (sidebar.js) hosted inside the IDE panel.
 * Sends, models, file review, and Virtual Office still go through the IDE services.
 */
export const ExtensionChatHost = () => {
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const settings = useInjectable<IOlkilSettingsService>(IOlkilSettingsService);
  const office = useInjectable<IOlkilVirtualOfficeService>(IOlkilVirtualOfficeService);
  const aiNode = useInjectable<IOlkilAiNodeService>(OlkilAiNodeServicePath);
  const workspace = useInjectable<IWorkspaceService>(IWorkspaceService);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const remoteRef = useRef<IdeRemote | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const sentRef = useRef<Map<string, string>>(new Map());
  const orderRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const filesSigRef = useRef('');

  const post = (msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(msg, '*');
  };

  const pushAuth = () => {
    const session = auth.getSession();
    const user = session?.user;
    const customs = (settings.get().customModels || []).map((item) => ({
      id: item.id,
      model: item.model,
      baseUrl: item.baseUrl,
      hasKey: Boolean(item.apiKey),
      label: item.label,
    }));
    post({
      type: 'auth',
      signedIn: auth.isSignedIn(),
      user: user
        ? { displayName: user.displayName || '', email: user.email || '' }
        : null,
      engineReady: true,
      paid: !chat.deepseekLocked,
      chatOpen: true,
      models: chat.models.map((model) => ({ id: model.id, label: model.label })),
      modelId: chat.modelId,
      customs,
      virtualOffice: office.active,
      voAssignee: office.assigneeId,
      voAssignees: VIRTUAL_OFFICE_ASSIGNEES.map((person) => ({
        id: person.id,
        name: person.name,
        role: person.role,
      })),
      voRunning: office.tasks.map((task) => ({
        workerId: task.workerId,
        workerName: task.workerName,
        status: task.status === 'running' ? 'running' : task.status,
      })),
      remoteAccess: Boolean(remoteRef.current?.isOn()),
    });
  };

  const emitMessage = (message: UiChatMessage) => {
    if (message.role === 'user') {
      post({ type: 'user', text: message.content });
      return;
    }
    if (message.role === 'assistant') {
      post({ type: 'assistant', text: message.content, live: Boolean(message.pending) });
      return;
    }
    if (message.role === 'activity' && message.activity) {
      const activity = message.activity;
      post({
        type: 'activity',
        id: message.id,
        label: activity.label,
        detail: activity.detail || activity.filePath || '',
        file: activity.filePath || '',
        command: activity.command || '',
        kind: extensionKind(activity.kind),
        done: Boolean(activity.done),
      });
      return;
    }
    if (message.role === 'status' && message.content) {
      post({ type: 'phase', label: message.content });
    }
  };

  const syncTranscript = () => {
    const messages = chat.messages;
    const ids = messages.map((message) => message.id);
    const previous = orderRef.current;
    const prefixOk = previous.every((id, index) => ids[index] === id);
    if (!prefixOk) {
      post({ type: 'reset' });
      sentRef.current.clear();
      filesSigRef.current = '';
    }
    for (const message of messages) {
      if (message.role === 'file_change' || message.role === 'todos') {
        continue;
      }
      const nextSig = messageSignature(message);
      if (sentRef.current.get(message.id) === nextSig) {
        continue;
      }
      emitMessage(message);
      sentRef.current.set(message.id, nextSig);
    }
    const files = messages
      .filter((message) => message.role === 'file_change' && message.fileChange)
      .map((message) => message.fileChange!);
    const filesSig = files
      .map((file) => `${file.id}:${file.status}:${file.additions}:${file.deletions}`)
      .join('|');
    if (filesSig !== filesSigRef.current) {
      filesSigRef.current = filesSig;
      if (files.length) {
        post({
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
    if (busyRef.current && !chat.busy) {
      post({ type: 'idle' });
    } else if (chat.busy && chat.status) {
      post({ type: 'phase', label: chat.status });
    }
    busyRef.current = chat.busy;
    orderRef.current = ids;
  };

  useEffect(() => {
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
      saveCustom: async (model, baseUrl, apiKey) => {
        const id = `c${Date.now().toString(36)}`;
        const current = settings.get().customModels || [];
        settings.patch({
          customModels: [
            ...current,
            { id, label: model, model, baseUrl, apiKey, enabled: true, updatedAt: Date.now() },
          ],
        });
        window.setTimeout(() => chat.setModel(customModelCatalogId(id)), 0);
      },
      watchChat: (sink) => chat.onDidChange(() => feedRemote(chat, sink, remoteFeed)),
      onChange: () => pushAuth(),
    });
    remoteRef.current = remote;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) {
        return;
      }
      void handleWebviewMessage(event.data || {}, {
        chat,
        auth,
        settings,
        office,
        remote,
        post,
        pushAuth,
        syncTranscript,
      });
    };
    window.addEventListener('message', onMessage);
    setSrcDoc(buildSrcDoc(String(logoUrl)));
    const chatSub = chat.onDidChange(() => {
      syncTranscript();
    });
    const authSub = auth.onDidChangeSession(() => pushAuth());
    const officeSub = office.onDidChange(() => pushAuth());
    return () => {
      window.removeEventListener('message', onMessage);
      chatSub.dispose();
      authSub.dispose();
      officeSub.dispose();
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
      style={{ flex: 1, width: '100%', height: '100%', border: 0, background: '#17181d' }}
    />
  );
};

function messageSignature(message: UiChatMessage): string {
  const activity = message.activity;
  return [
    message.role,
    message.content,
    message.pending ? '1' : '0',
    activity?.label || '',
    activity?.done ? '1' : '0',
    activity?.filePath || '',
  ].join('\u0001');
}

function extensionKind(kind: string): string {
  if (kind === 'editing') return 'edit';
  if (kind === 'reading') return 'read';
  if (kind === 'searching') return 'search';
  if (kind === 'running') return 'command';
  return kind;
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
      --vscode-sideBar-background: #17181d;
      --vscode-editor-background: #1a1b21;
      --vscode-foreground: rgba(255,255,255,.92);
      --vscode-descriptionForeground: rgba(255,255,255,.55);
      --vscode-widget-border: rgba(255,255,255,.1);
      --vscode-input-background: #121318;
      --vscode-font-family: "Segoe UI", sans-serif;
      --vscode-editor-font-family: ui-monospace, Consolas, monospace;
    }
  </style>
  <style>${sidebarCss}</style>
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

async function handleWebviewMessage(
  msg: {
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
  },
  ctx: {
    chat: IOlkilChatService;
    auth: IOlkilAuthService;
    settings: IOlkilSettingsService;
    office: IOlkilVirtualOfficeService;
    remote: IdeRemote;
    post: (msg: Record<string, unknown>) => void;
    pushAuth: () => void;
    syncTranscript: () => void;
  },
) {
  const { chat, auth, settings, office, pushAuth } = ctx;
  switch (msg.type) {
    case 'ready':
      chat.init();
      pushAuth();
      ctx.syncTranscript();
      break;
    case 'signIn':
      await auth.signIn();
      pushAuth();
      break;
    case 'signOut':
      await auth.signOut();
      pushAuth();
      break;
    case 'send': {
      const mode = msg.mode === 'ask' ? 'ask' : 'agent';
      chat.setChatMode(mode);
      await chat.send(String(msg.text || ''));
      break;
    }
    case 'abort':
      chat.stop();
      break;
    case 'newChat':
      chat.newChat();
      break;
    case 'setModel': {
      const modelId = String(msg.modelId || '');
      if (modelId && modelId !== 'custom') {
        chat.setModel(modelId);
      }
      pushAuth();
      break;
    }
    case 'saveCustom': {
      const model = String(msg.model || '').trim();
      const baseUrl = String(msg.baseUrl || '').trim();
      const apiKey = String(msg.apiKey || '').trim();
      if (!model || !baseUrl || !apiKey) {
        break;
      }
      const id = String(msg.id || '').trim() || `c${Date.now().toString(36)}`;
      const current = settings.get().customModels || [];
      const next = current.some((item) => item.id === id)
        ? current.map((item) =>
            item.id === id ? { ...item, model, baseUrl, apiKey, label: model, updatedAt: Date.now() } : item,
          )
        : [
            ...current,
            {
              id,
              label: model,
              model,
              baseUrl,
              apiKey,
              enabled: true,
              updatedAt: Date.now(),
            },
          ];
      settings.patch({ customModels: next });
      window.setTimeout(() => chat.setModel(customModelCatalogId(id)), 0);
      break;
    }
    case 'deleteCustom': {
      const id = String(msg.id || '').replace(/^custom:/, '');
      settings.patch({
        customModels: (settings.get().customModels || []).filter((item) => item.id !== id),
      });
      pushAuth();
      break;
    }
    case 'listContextFiles': {
      const files = await chat.listMentionCandidates('', 40);
      ctx.post({
        type: 'contextFiles',
        files: files.map((file) => ({ path: file.path, name: file.name })),
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
    case 'toggleVirtualOffice':
      if (office.active) {
        office.exit();
      } else {
        office.enter();
      }
      pushAuth();
      break;
    case 'setVoAssignee':
      if (isAssigneeId(msg.id)) {
        office.setAssignee(msg.id);
      }
      pushAuth();
      break;
    case 'openPlan':
      window.open('https://olkil.com', '_blank', 'noopener');
      break;
    case 'toggleRemoteAccess': {
      const on = await ctx.remote.toggle();
      pushAuth();
      const url = ctx.remote.qrUrl();
      ctx.post({ type: 'remoteQr', open: on && Boolean(url), url });
      break;
    }
    case 'showRemoteQr': {
      if (!ctx.remote.isOn()) {
        await ctx.remote.start();
      }
      pushAuth();
      const url = ctx.remote.qrUrl();
      if (url) {
        ctx.post({ type: 'remoteQr', open: true, url });
      }
      break;
    }
    case 'abortVo': {
      const workerId = String(msg.workerId || '');
      const task = office.tasks.find((item) => item.workerId === workerId && item.status === 'running');
      if (task) {
        await office.cancelTask(task.id);
      }
      break;
    }
    default:
      break;
  }
}

function isAssigneeId(value: string | undefined): value is VirtualOfficeAssigneeId {
  return VIRTUAL_OFFICE_ASSIGNEES.some((person) => person.id === value);
}
