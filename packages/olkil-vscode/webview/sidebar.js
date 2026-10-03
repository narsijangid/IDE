if (!window.__olkilOutsideClose) {
  window.__olkilOutsideClose = true;
  document.addEventListener(
    'mousedown',
    (ev) => {
      const t = ev.target;
      let dirty = false;
      if (state.modelMenu) {
        const picker = document.querySelector('.model-picker-inner');
        if (!(picker && picker.contains(t))) {
          state.modelMenu = false;
          dirty = true;
        }
      }
      if (state.modeMenu) {
        const box = document.querySelector('.mode-menu-wrap');
        if (!(box && box.contains(t))) {
          state.modeMenu = false;
          dirty = true;
        }
      }
      if (state.effortMenu) {
        const box = document.querySelector('.effort-menu-wrap');
        if (!(box && box.contains(t))) {
          state.effortMenu = false;
          dirty = true;
        }
      }
      if (state.atMenu) {
        const box = document.getElementById('atMenu');
        const surface = document.querySelector('.input-surface');
        if (!(box && box.contains(t)) && !(surface && surface.contains(t))) {
          state.atMenu = false;
          dirty = true;
        }
      }
      if (dirty) render({ keepFocus: true });
    },
    true,
  );
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    let dirty = false;
    if (state.modelMenu) {
      state.modelMenu = false;
      dirty = true;
    }
    if (state.modeMenu) {
      state.modeMenu = false;
      dirty = true;
    }
    if (state.effortMenu) {
      state.effortMenu = false;
      dirty = true;
    }
    if (dirty) render({ keepFocus: true });
  });
}

const vscode = acquireVsCodeApi();
window.olkilVs = vscode;
const app = document.getElementById('app');
const icon = app.getAttribute('data-icon') || '';
/** Skip chat remount while the user is mid-keystroke (prevents phase/loader blink). */
let inputTypingUntil = 0;
let typingQuietTimer = null;

const state = {
  signedIn: false,
  user: null,
  quota: null,
  engineReady: false,
  paid: false,
  chatOpen: false,
  upgrade: false,
  upgradeReason: '',
  plans: [],
  models: [],
  modelId: 'auto',
  modelMenu: false,
  modelQuery: '',
  custom: { id: '', model: '', baseUrl: '', hasKey: false, apiKey: '' },
  customs: [],
  addingCustom: false,
  busy: false,
  draft: '',
  messages: [],
  liveStatus: null,
  activityOpen: {},
  ink: null,
  phase: '',
  /** 'agent' | 'ask' — Ask = answer only (soft client hint); Agent = full tools */
  chatMode: 'agent',
  modeMenu: false,
  /** UI-only effort: 'low' | 'medium' | 'high' — not wired to engine yet */
  effortLevel: 'medium',
  effortMenu: false,
  effortPct: 50,
  reviewOpen: false,
  composerImages: [],
  atMenu: false,
  atQuery: '',
  contextFiles: [],
  virtualOffice: false,
  voAssignee: 'manager',
  voAssignees: [
    { id: 'manager', name: 'Manager', role: 'Auto-assign' },
    { id: 'alex', name: 'Alex', role: 'Developer' },
    { id: 'elon', name: 'Elon', role: 'Developer' },
    { id: 'sophia', name: 'Sophia', role: 'Developer' },
    { id: 'robert', name: 'Robert', role: 'Developer' },
    { id: 'jasmine', name: 'Jasmine', role: 'QA' },
  ],
  voRunning: [],
  voInspected: '',
  /** Per-teammate chat threads in Virtual Office mode */
  voChats: {},
  voActiveChat: '',
  voWorkerName: '',
  pocketOn: false,
  pocketCode: '',
  pocketError: '',
  remoteAccess: false,
};

function ensureVoChat(workerId) {
  if (!workerId) return null;
  if (!state.voChats[workerId]) {
    state.voChats[workerId] = { messages: [], phase: '', workerName: '' };
  }
  return state.voChats[workerId];
}

function bindActiveVoMessages() {
  if (state.virtualOffice && state.voActiveChat) {
    const chat = ensureVoChat(state.voActiveChat);
    state.messages = chat.messages;
    state.phase = chat.phase || state.phase;
  }
}

function hydrateVoMessages(rawList) {
  return (rawList || [])
    .map((m) => {
      if (m.type === 'user' || m.role === 'user') return { role: 'user', text: m.text || m.prompt || '' };
      if (m.type === 'assistant' || m.role === 'assistant')
        return { role: 'assistant', text: m.text || '', live: !!m.live };
      if (m.type === 'activity' || m.role === 'activity')
        return {
          role: 'activity',
          id: m.id || 'a',
          label: m.label || m.text || '',
          detail: m.detail || '',
          done: !!m.done,
          kind: m.kind || '',
          file: m.file || '',
          line: m.line || '',
          badge: m.badge || '',
          title: m.title || '',
          action: m.action || '',
        };
      if (m.type === 'error' || m.role === 'error') return { role: 'error', text: m.text || '' };
      return null;
    })
    .filter(Boolean);
}

function openVoChat(workerId, opts) {
  opts = opts || {};
  if (!workerId) return;
  // Preserve current thread before switching
  if (state.voActiveChat && state.voChats[state.voActiveChat]) {
    state.voChats[state.voActiveChat].messages = state.messages;
    state.voChats[state.voActiveChat].phase = state.phase;
  }
  const chat = ensureVoChat(workerId);
  if (opts.workerName) chat.workerName = opts.workerName;
  if (opts.fresh) {
    chat.messages = [];
    if (opts.prompt) chat.messages.push({ role: 'user', text: opts.prompt });
    chat.phase = opts.workerName ? opts.workerName + ' working' : '';
  } else {
    // Switch back to this teammate — keep the richer of local thread vs host log
    const hydrated = hydrateVoMessages(opts.messages);
    if (hydrated.length > (chat.messages || []).length) {
      chat.messages = hydrated;
    }
    if (opts.phase) chat.phase = opts.phase;
    else if (!chat.phase && opts.workerName) chat.phase = opts.workerName + ' working';
  }
  state.voActiveChat = workerId;
  state.voInspected = workerId;
  state.voWorkerName = chat.workerName || opts.workerName || workerId;
  state.messages = chat.messages;
  state.phase = chat.phase || '';
  state.busy = false;
}

/** Route host messages into the correct VO teammate thread (or main chat). */
function routeVoMessage(msg, applyFn) {
  const wid = msg.voWorkerId || (state.virtualOffice ? state.voActiveChat : '');
  if (state.virtualOffice && wid) {
    const chat = ensureVoChat(wid);
    const prevMsgs = state.messages;
    const prevPhase = state.phase;
    const prevActive = state.voActiveChat;
    state.messages = chat.messages;
    applyFn();
    chat.messages = state.messages;
    chat.phase = state.phase;
    if (prevActive === wid || state.voActiveChat === wid) {
      // Viewing this thread — keep bound
      state.voActiveChat = wid;
      state.messages = chat.messages;
      render({ keepFocus: true });
    } else {
      // Background update — restore the chat the user is looking at
      state.messages = prevMsgs;
      state.phase = prevPhase;
    }
    return;
  }
  applyFn();
  render({ keepFocus: true });
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function planLabel() {
  const q = state.quota;
  if (!q) return state.signedIn ? 'Signed in' : 'Sign in';
  const bits = [q.planName || 'Plan'];
  if (q.leftLabel) bits.push(q.leftLabel);
  const used = Number(q.percentUsed);
  if (Number.isFinite(used) && used > 0) bits.push(Math.round(used) + '% used');
  return bits.join(' · ');
}

function lastUserIndex() {
  let idx = -1;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].role === 'user') idx = i;
  }
  return idx;
}

function voWorkerFinished(workerId) {
  if (!workerId || !state.virtualOffice) return false;
  const run = (state.voRunning || []).find((r) => r.workerId === workerId);
  return !run || run.status !== 'running';
}

function activeVoFinished() {
  return !!(state.virtualOffice && state.voActiveChat && voWorkerFinished(state.voActiveChat));
}

/** Force every open step closed — used when banner says done / idle arrives. */
function forceThreadSettled() {
  pruneHollowActivities();
  settleThreadActivities();
  for (const m of state.messages) {
    if (m.role === 'assistant') m.live = false;
    if (m.role === 'files' && Array.isArray(m.files)) {
      m.files = m.files.map((f) => ({ ...f, live: false }));
    }
  }
  pinSummaryAtEnd();
}

function cleanActivityPath(p) {
  let s = String(p || '')
    .replace(/\\/g, '/')
    .trim();
  // Engine sometimes prefixes tool namespace as "Action/file.html"
  s = s.replace(/^action\//i, '');
  s = s.replace(/^tool\//i, '');
  s = s.replace(/^files?\//i, '');
  if (/^action$/i.test(s)) return '';
  return s;
}

function fileBaseKey(p) {
  const s = cleanActivityPath(p).toLowerCase();
  if (!s || s === 'file') return '';
  const parts = s.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || '';
  return base && base !== 'file' ? base : '';
}

function shortPath(p) {
  const s = cleanActivityPath(p);
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || s;
  return parts.slice(-2).join('/');
}

/**
 * Commercial feed rule (Cursor-class):
 * Only the single trailing activity AFTER the last assistant may animate.
 * Everything earlier is history — never a spinning "Editing" card mid-chat.
 */
function normalizeFeedForRender() {
  if (activeVoFinished()) {
    forceThreadSettled();
    return;
  }
  let lastAsst = -1;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].role === 'assistant') lastAsst = i;
  }
  let tip = -1;
  for (let i = state.messages.length - 1; i > lastAsst; i--) {
    if (state.messages[i].role === 'activity' && !isNoiseActivity(state.messages[i])) {
      tip = i;
      break;
    }
  }
  const workerBusy =
    !state.virtualOffice ||
    (state.voActiveChat &&
      (state.voRunning || []).some((r) => r.workerId === state.voActiveChat && r.status === 'running')) ||
    (!state.virtualOffice && state.busy);

  for (let i = 0; i < state.messages.length; i++) {
    const m = state.messages[i];
    if (m.role !== 'activity') continue;
    m.file = cleanActivityPath(m.file || '');
    m.detail = cleanActivityPath(m.detail || '');
    if (i !== tip || !workerBusy) {
      m.done = true;
    }
  }
}

function activityHasAssistantAfter(idx) {
  for (let i = idx + 1; i < state.messages.length; i++) {
    if (state.messages[i].role === 'assistant') return true;
  }
  return false;
}

function upsertMessage(msg) {
  const afterUser = lastUserIndex();
  if (msg.role === 'activity') {
    const finished = activeVoFinished();
    if (!msg.done && finished) return;
    if (finished) msg = { ...msg, done: true };

    msg = {
      ...msg,
      file: cleanActivityPath(msg.file || ''),
      detail: cleanActivityPath(msg.detail || ''),
    };

    if (!msg.done) {
      for (let i = afterUser + 1; i < state.messages.length; i++) {
        if (
          state.messages[i].role === 'activity' &&
          activityFingerprint(state.messages[i]) !== activityFingerprint(msg)
        ) {
          state.messages[i].done = true;
        }
      }
    }
    const fp = activityFingerprint(msg);
    const idx = state.messages.findIndex(
      (m, i) =>
        i > afterUser &&
        m.role === 'activity' &&
        (m.id === msg.id || (fp && activityFingerprint(m) === fp)),
    );
    if (idx >= 0) {
      const prev = state.messages[idx];
      // Never reopen a settled step that already sits above assistant prose
      let nextDone = finished || !!msg.done;
      if (prev.done && !msg.done && activityHasAssistantAfter(idx)) nextDone = true;
      if (prev.done && !msg.done && finished) nextDone = true;
      state.messages[idx] = {
        ...prev,
        ...msg,
        id: msg.id || prev.id,
        done: nextDone,
        file: msg.file || prev.file || '',
        kind: msg.kind || prev.kind || '',
        title: msg.title && msg.title !== 'file' ? msg.title : prev.title || msg.title || '',
        line: msg.line || prev.line || '',
        detail: msg.detail || prev.detail || '',
        label: nextDone && (msg.line || prev.line) ? msg.line || prev.line : msg.label || prev.label,
      };
      return;
    }
    state.messages.push({
      ...msg,
      done: finished ? true : !!msg.done,
    });
    return;
  }
  if (msg.role === 'files') {
    upsertFilesCard(Array.isArray(msg.files) ? msg.files : []);
  }
}

function activityFingerprint(a) {
  const kind = String((a && a.kind) || '');
  const base = fileBaseKey((a && (a.file || a.detail || a.title)) || '');
  // Basename so Action/login.html and login.html collapse to one row
  if (base && /^(create|edit)$/.test(kind)) return 'file:' + base;
  if (base && kind === 'read') return 'read:' + base;
  if (kind === 'search') return 'search:' + String((a && (a.line || a.label)) || '').toLowerCase();
  if (kind === 'bash') return 'bash:' + String((a && (a.command || a.detail)) || '').slice(0, 100);
  if (kind === 'tool') return 'tool:' + String((a && (a.label || a.title)) || '').toLowerCase().slice(0, 80);
  return '';
}

function textsNearlySame(a, b) {
  const x = String(a || '').replace(/\s+/g, ' ').trim();
  const y = String(b || '').replace(/\s+/g, ' ').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length > 40 && y.length > 40 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

function mergeAssistantList(assistants) {
  const merged = [];
  for (const a of assistants) {
    const last = merged[merged.length - 1];
    if (last && textsNearlySame(last.text, a.text)) {
      const pick =
        String(a.text || '').length >= String(last.text || '').length
          ? { ...a, live: false }
          : { ...last, live: false };
      merged[merged.length - 1] = pick;
      continue;
    }
    merged.push({ ...a, live: !!a.live });
  }
  return merged;
}

/**
 * Commercial thread order (always):
 * activities → file diffs → assistant summary LAST
 * so scrolling to the bottom always shows the final reply.
 */
function pinSummaryAtEnd() {
  const afterUser = lastUserIndex();
  if (afterUser < 0 && !state.messages.length) return;
  const head = afterUser >= 0 ? state.messages.slice(0, afterUser + 1) : [];
  const rest = afterUser >= 0 ? state.messages.slice(afterUser + 1) : state.messages.slice();
  const activities = [];
  const other = [];
  let files = null;
  const assistants = [];
  for (const m of rest) {
    if (m.hide) continue;
    if (m.role === 'activity') activities.push(m);
    else if (m.role === 'files') files = m;
    else if (m.role === 'assistant') assistants.push(m);
    else other.push(m);
  }
  const merged = mergeAssistantList(assistants);
  // If the last assistant is an early "I'll create…" and a later Done exists earlier, put Done last
  let finalIdx = -1;
  for (let i = 0; i < merged.length; i++) {
    if (/^\s*done\b/i.test(String(merged[i].text || '')) || /\bsummary\s*:/i.test(String(merged[i].text || ''))) {
      finalIdx = i;
    }
  }
  if (finalIdx >= 0 && finalIdx < merged.length - 1) {
    const [doneMsg] = merged.splice(finalIdx, 1);
    merged.push({ ...doneMsg, live: false });
  }
  state.messages = [...head, ...activities, ...other, ...(files ? [files] : []), ...merged];
}

function upsertFilesCard(files) {
  const afterUser = lastUserIndex();
  const fileMsg = { role: 'files', files };
  const idx = state.messages.findIndex((m, i) => i > afterUser && m.role === 'files');
  if (idx >= 0) {
    state.messages[idx] = fileMsg;
    return;
  }
  // Insert BEFORE the first assistant so the summary stays at the bottom
  let asst = -1;
  for (let i = afterUser + 1; i < state.messages.length; i++) {
    if (state.messages[i].role === 'assistant') {
      asst = i;
      break;
    }
  }
  if (asst >= 0) state.messages.splice(asst, 0, fileMsg);
  else state.messages.push(fileMsg);
}

function upsertAssistant(text, live) {
  const afterUser = lastUserIndex();
  let last = null;
  let lastIdx = -1;
  for (let i = state.messages.length - 1; i > afterUser; i--) {
    if (state.messages[i].role === 'assistant') {
      last = state.messages[i];
      lastIdx = i;
      break;
    }
  }
  if (last && last.live) {
    last.text = text;
    last.live = !!live;
    if (!live) pinSummaryAtEnd();
    return;
  }
  if (last && textsNearlySame(last.text, text)) {
    last.text = text.length >= String(last.text || '').length ? text : last.text;
    last.live = !!live;
    if (!live) pinSummaryAtEnd();
    return;
  }
  // Also merge into any earlier near-duplicate in this turn (kills double "Done." bubbles)
  for (let i = state.messages.length - 1; i > afterUser; i--) {
    const m = state.messages[i];
    if (m.role === 'assistant' && textsNearlySame(m.text, text)) {
      m.text = text.length >= String(m.text || '').length ? text : m.text;
      m.live = !!live;
      if (!live) pinSummaryAtEnd();
      return;
    }
  }
  state.messages.push({ role: 'assistant', text, live: !!live });
  if (!live) pinSummaryAtEnd();
}

function scrollChat(node) {
  const go = () => {
    node.scrollTop = node.scrollHeight;
  };
  go();
  requestAnimationFrame(() => {
    go();
    requestAnimationFrame(go);
  });
  setTimeout(go, 50);
}

function settleThreadActivities() {
  for (const m of state.messages) {
    if (m.role === 'activity') m.done = true;
  }
}

/** Drop bogus "Creating file" / empty-path rows that never got a real target. */
function pruneHollowActivities() {
  state.messages = state.messages.filter((m) => {
    if (m.role !== 'activity') return true;
    if (m.done) return true;
    const kind = String(m.kind || '');
    if (!/^(create|edit)$/.test(kind)) return true;
    const file = String(m.file || m.detail || m.title || '')
      .replace(/\\/g, '/')
      .trim();
    const hollow = !file || file.toLowerCase() === 'file' || /^(creating|editing|writing)\s+file$/i.test(String(m.label || ''));
    return !hollow;
  });
}

function liveTaskTitle(a) {
  const stripVerb = (s) =>
    String(s || '')
      .replace(/^(Creating|Created|Editing|Edited|Writing|Wrote|Reading|Read|Searching|Looking up)\s+/i, '')
      .trim();
  let title = '';
  if (a.title && String(a.title).toLowerCase() !== 'file') title = String(a.title).trim();
  if (!title) title = shortPath(a.file || '') || '';
  if (!title) {
    const fromDetail = shortPath(a.detail || '');
    if (fromDetail && fromDetail.toLowerCase() !== 'file') title = fromDetail;
  }
  if (!title) title = stripVerb(a.line || a.label || '');
  if (!title || title.toLowerCase() === 'file') title = 'file';
  return stripVerb(title) || title;
}

function syncSendButton() {
  const btn = document.getElementById('send');
  const input = document.getElementById('input');
  if (!btn || !input) return;
  const voWorkerBusy =
    state.virtualOffice &&
    state.voActiveChat &&
    (state.voRunning || []).some((r) => r.workerId === state.voActiveChat && r.status === 'running');
  const sendBtnIsStop = (state.busy && !state.virtualOffice) || (!!(voWorkerBusy && !String(input.value || '').trim()));
  btn.className = 'send-btn' + (sendBtnIsStop ? ' send-btn-stop' : '');
  btn.title = sendBtnIsStop ? 'Stop' : 'Send';
  btn.setAttribute('aria-label', sendBtnIsStop ? 'Stop' : 'Send');
  btn.innerHTML = sendBtnIsStop
    ? '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/** Replace only .msgs so typing in the composer does not remount / blink the feed. */
function patchMsgsOnly() {
  const old = document.querySelector('.msgs');
  if (!old || !document.querySelector('.composer')) {
    render({ keepFocus: true });
    return;
  }
  const msgs = buildMsgsNode();
  old.replaceWith(msgs);
  scrollChat(msgs);
  syncSendButton();
}

function buildMsgsNode() {
  normalizeFeedForRender();

  const msgs = el('<div class="msgs"></div>');
  if (state.virtualOffice && state.voActiveChat) {
    const name = state.voWorkerName || state.voActiveChat;
    const running = (state.voRunning || []).find((r) => r.workerId === state.voActiveChat);
    const isWorking = running && running.status === 'running';
    const status = isWorking ? ' · working' : running ? ` · ${running.status}` : '';
    const banner = el(
      `<div class="vo-chat-banner"><span class="vo-chat-name">${escapeHtml(name)}</span><span class="vo-chat-meta">chat${escapeHtml(status)} · click a cabin to switch</span>${
        isWorking ? '<button type="button" class="vo-stop-btn" id="voStop">Stop</button>' : ''
      }</div>`,
    );
    msgs.appendChild(banner);
    const stopBtn = banner.querySelector('#voStop');
    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'abortVo', workerId: state.voActiveChat });
      });
    }
  }
  if (!state.messages.length) {
    msgs.appendChild(
      el(`<div class="hero">
        <h1>${state.virtualOffice && state.voActiveChat ? 'Task for ' + escapeHtml(state.voWorkerName || state.voActiveChat) : 'What should we ship?'}</h1>
        <p>${
          state.virtualOffice
            ? 'Send another prompt to assign a free teammate in parallel. Click a cabin to open that chat.'
            : 'OLKIL uses your open files and selection. Press Ctrl+L / Cmd+L anytime.'
        }</p>
      </div>`),
    );
  } else {
    const seenFp = new Set();
    const pending = [];
    const flushActs = () => {
      const vis = [];
      for (const a of pending) {
        if (a.hide || isNoiseActivity(a)) continue;
        const fp = activityFingerprint(a) || ('line:' + activityLine(a).toLowerCase());
        // Same file already shown earlier in this thread — skip duplicate Explore/Read rows
        if (fp && seenFp.has(fp) && a.done) continue;
        if (fp) seenFp.add(fp);
        vis.push(a);
      }
      pending.length = 0;
      if (!vis.length) return;
      msgs.appendChild(renderAgentTimeline(vis));
    };
    for (const m of state.messages) {
      if (m.role === 'activity') {
        pending.push(m);
        continue;
      }
      flushActs();
      if (m.role === 'files') {
        msgs.appendChild(fileCard(m.files || []));
        continue;
      }
      if (m.role === 'assistant') {
        msgs.appendChild(el(`<div class="bubble assistant md${m.live ? ' live' : ''}">${formatMarkdown(m.text)}</div>`));
        continue;
      }
      if (m.role === 'user') {
        msgs.appendChild(renderUserBubble(m));
        continue;
      }
      msgs.appendChild(el(`<div class="bubble ${m.role}">${escapeHtml(m.text)}</div>`));
    }
    flushActs();
    ensureWorkingPhase();
    if (shouldShowWorkingPhase()) {
      msgs.appendChild(
        el(`<div class="phase-line" role="status"><span class="phase-shine">${escapeHtml(workingPhaseLabel())}</span></div>`),
      );
    }
  }
  return msgs;
}

function render(opts) {
  const keepFocus = opts && opts.keepFocus;
  const active = document.activeElement;
  const typingId = active && active.id;
  const typing = typingId === 'input' || typingId === 'cModel' || typingId === 'cBase' || typingId === 'cKey' || typingId === 'modelSearch';
  // Actively typing in Ask box: never remount chat (restarts phase-shine / live loaders → blink).
  // After a short pause, the quiet timer flushes pending updates with caret restored.
  const activelyTyping = typingId === 'input' && Date.now() < inputTypingUntil;
  if (activelyTyping && document.querySelector('.composer')) {
    if (active && typeof active.value === 'string') state.draft = active.value;
    syncSendButton();
    return;
  }
  const customs = Array.isArray(state.customs) ? state.customs : [];
  const showCustomForm = state.modelId === 'custom' || state.addingCustom;
  const draft = typingId === 'input' ? active.value : state.draft;
  const customDraft = {
    model: typingId === 'cModel' ? active.value : (state.custom && state.custom.model) || '',
    baseUrl: typingId === 'cBase' ? active.value : (state.custom && state.custom.baseUrl) || '',
    apiKey: typingId === 'cKey' ? active.value : (state.custom && state.custom.apiKey) || '',
  };
  const name = (state.user && (state.user.displayName || state.user.email)) || '';
  app.innerHTML = '';

  const top = el(
    `<div class="top">
      <img alt="" src="${icon}" />
      <span class="brand">OLKIL</span>
      <div class="model-picker" id="modelPicker"></div>
      <button type="button" class="vo-pill${state.virtualOffice ? ' on' : ''}" id="voBtn" title="${
        state.virtualOffice ? 'Dev Studio' : 'Vertual Office'
      }">${state.virtualOffice ? 'Dev Studio' : 'Vertual Office'}</button>
      <span class="plan">${escapeHtml(planLabel() || (state.signedIn ? name : 'Sign in'))}</span>
    </div>`,
  );
  app.appendChild(top);
  top.querySelector('#voBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleVirtualOffice' });
  });

  const remote = el(`<div class="remote-row${state.remoteAccess ? ' on' : ''}">
    <button type="button" class="switch${state.remoteAccess ? ' on' : ''}" id="remoteBtn" role="switch" aria-checked="${state.remoteAccess ? 'true' : 'false'}" title="Keep the screen on while Cursor is open"><i></i></button>
    <span id="remoteLabel">Remote Access</span>
  </div>`);
  remote.querySelector('#remoteBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleRemoteAccess' });
  });
  remote.querySelector('#remoteLabel').addEventListener('click', () => {
    vscode.postMessage({ type: state.remoteAccess ? 'showRemoteQr' : 'toggleRemoteAccess' });
  });
  app.appendChild(remote);

  if (state.signedIn && state.virtualOffice) {
    const bar = el(`<div class="vo-assignee">
      <span>Assign</span>
      <select id="voAssignee"></select>
    </div>`);
    const sel = bar.querySelector('#voAssignee');
    for (const a of state.voAssignees || []) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + (a.role ? ' · ' + a.role : '');
      if (a.id === state.voAssignee) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      state.voAssignee = sel.value;
      vscode.postMessage({ type: 'setVoAssignee', id: sel.value });
    });
    app.appendChild(bar);
  }
  const modelPicker = top.querySelector('#modelPicker');
  if (state.signedIn) {
    const current = (state.models || []).find((m) => m.id === state.modelId);
    const picker = el(`<div class="model-picker-inner">
      <button type="button" class="model-select" id="modelBtn">${escapeHtml((current && current.label) || 'Auto')} ▾</button>
    </div>`);
    modelPicker.appendChild(picker);
    picker.querySelector('#modelBtn').addEventListener('click', () => {
      state.modelMenu = !state.modelMenu;
      render({ keepFocus: true });
    });
    if (state.modelMenu) {
      const q = (typingId === 'modelSearch' ? active.value : state.modelQuery || '').toLowerCase();
      const menu = el(`<div class="model-menu">
        <input id="modelSearch" type="text" placeholder="Search models" value="${escapeHtml(state.modelQuery || '')}" />
        <div class="model-list"></div>
      </div>`);
      const list = menu.querySelector('.model-list');
      const rows = state.models || [];
      for (const m of rows) {
        if (m.id === 'custom') continue;
        const hay = ((m.label || '') + ' ' + (m.id || '')).toLowerCase();
        if (q && hay.indexOf(q) < 0) continue;
        const opt = el(`<button type="button" class="model-option${m.id === state.modelId ? ' active' : ''}">${escapeHtml(m.label)}</button>`);
        opt.addEventListener('click', () => {
          state.modelId = m.id;
          state.modelMenu = false;
          state.modelQuery = '';
          state.addingCustom = false;
          vscode.postMessage({ type: 'setModel', modelId: m.id });
          render({ keepFocus: true });
        });
        list.appendChild(opt);
      }
      const add = el(`<button type="button" class="model-option add-custom${state.modelId === 'custom' || state.addingCustom ? ' active' : ''}">Add custom model</button>`);
      add.addEventListener('click', () => {
        state.modelId = 'custom';
        state.modelMenu = false;
        state.modelQuery = '';
        state.addingCustom = true;
        state.custom = { id: '', model: '', baseUrl: '', hasKey: false, apiKey: '' };
        vscode.postMessage({ type: 'setModel', modelId: 'custom' });
        render({ keepFocus: true });
      });
      list.appendChild(add);
      menu.querySelector('#modelSearch').addEventListener('input', (e) => {
        state.modelQuery = e.target.value;
        render({ keepFocus: true });
      });
      picker.appendChild(menu);
    }
  } else {
    modelPicker.remove();
  }

  if (!state.signedIn) {
    const hero = el(`<div class="hero">
      <h1>Agent in your editor</h1>
      <p>Sign in with the same olkil.com account you use in the OLKIL desktop app. Chat, review diffs, and keep working in VS Code.</p>
      <button class="primary" id="signin">Sign in</button>
    </div>`);
    app.appendChild(hero);
    hero.querySelector('#signin').addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
    return;
  }

  if (showCustomForm) {
    const c = state.custom || {};
    const custom = el(`<div class="custom">
      <div class="custom-title">${c.id ? 'Edit custom model' : 'Add custom model'}</div>
      <input id="cModel" type="text" placeholder="Model id" value="${escapeHtml(customDraft.model || '')}" />
      <input id="cBase" type="text" placeholder="Base URL" value="${escapeHtml(customDraft.baseUrl || '')}" />
      <input id="cKey" type="password" placeholder="${c.hasKey || customDraft.apiKey ? 'API key saved' : 'API key'}" />
      <div class="custom-actions">
        <button class="primary" id="cSave" type="button">Save</button>
        <button class="ghost" id="cCancel" type="button">Cancel</button>
      </div>
    </div>`);
    app.appendChild(custom);
    custom.querySelector('#cSave').addEventListener('click', () => {
      const apiKey = custom.querySelector('#cKey').value.trim() || state.custom.apiKey;
      state.custom.apiKey = apiKey;
      state.custom.model = custom.querySelector('#cModel').value.trim();
      state.custom.baseUrl = custom.querySelector('#cBase').value.trim();
      state.custom.hasKey = Boolean(apiKey);
      state.addingCustom = false;
      vscode.postMessage({
        type: 'saveCustom',
        id: state.custom.id || '',
        model: state.custom.model,
        baseUrl: state.custom.baseUrl,
        apiKey,
      });
    });
    custom.querySelector('#cCancel').addEventListener('click', () => {
      state.addingCustom = false;
      const first = customs[0];
      state.modelId = first ? 'custom:' + first.id : 'auto';
      vscode.postMessage({ type: 'setModel', modelId: state.modelId });
      render({ keepFocus: true });
    });
  } else if (String(state.modelId || '').indexOf('custom:') === 0) {
    const current = customs.find((c) => 'custom:' + c.id === state.modelId) || state.custom || {};
    const bar = el(`<div class="custom-bar">
      <span>Using <strong>${escapeHtml(current.model || 'custom')}</strong></span>
      <button class="ghost" id="cChange" type="button">Change</button>
      <button class="ghost" id="cDelete" type="button">Delete</button>
    </div>`);
    app.appendChild(bar);
    bar.querySelector('#cChange').addEventListener('click', () => {
      state.addingCustom = true;
      state.custom = {
        id: current.id || '',
        model: current.model || '',
        baseUrl: current.baseUrl || '',
        hasKey: !!current.hasKey,
        apiKey: '',
      };
      render({ keepFocus: true });
    });
    bar.querySelector('#cDelete').addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteCustom', id: current.id || '' });
    });
  }

  const msgs = buildMsgsNode();
  app.appendChild(msgs);
  scrollChat(msgs);

  if (state.upgrade) {
    const trialBlocked = state.upgradeReason === 'trial-blocked';
    const trialEnded = state.upgradeReason === 'trial-ended';
    const upgrade = el(`<div class="upgrade-pop">
      <h1>${
        trialBlocked
          ? 'Free trial already used on this computer'
          : trialEnded
            ? 'Free tokens are used up'
            : state.quota && state.quota.isPaid
              ? 'Your included usage is used up'
              : 'Upgrade to run OLKIL cloud models'
      }</h1>
      <p>${
        trialBlocked
          ? 'Another account on this computer already took the free trial. Lite, Pro, or Ultra will work on this account.'
          : trialEnded
            ? 'Each free account gets 30,000 tokens. Upgrade to Lite or Pro to keep using OLKIL.'
            : state.quota && state.quota.isPaid
              ? 'Buy Lite, Pro, or Ultra again — same wallet as the OLKIL desktop app.'
              : 'Free includes chat. Cloud agent needs Lite, Pro, or Ultra — or pick Custom at the top and use your own API.'
      }</p>
      <div class="plans">
        <div class="plan-card free">
          <span class="plan-name">Free</span>
          <span class="plan-price">Free</span>
          <span class="plan-blurb">30,000 tokens · Bring your own API key</span>
        </div>
      </div>
      <button class="ghost" id="dismissUpgrade">Keep chatting</button>
    </div>`);
    const plans = upgrade.querySelector('.plans');
    for (const p of state.plans) {
      const card = el(`<button class="plan-card${p.featured ? ' featured' : ''}" data-plan="${p.id}">
        <span class="plan-name">${escapeHtml(p.name)}</span>
        <span class="plan-price">${escapeHtml(p.price)}<small>${escapeHtml(p.period)}</small></span>
        <span class="plan-blurb">${escapeHtml(p.blurb)}</span>
        <span class="plan-cta">${p.featured ? 'Get Pro' : 'Upgrade'}</span>
      </button>`);
      card.addEventListener('click', () => vscode.postMessage({ type: 'openPlan', plan: p.id }));
      plans.appendChild(card);
    }
    upgrade.querySelector('#dismissUpgrade').addEventListener('click', () => {
      state.upgrade = false;
      render({ keepFocus: true });
    });
    app.appendChild(upgrade);
  }

  const voWorkerBusy =
    state.virtualOffice &&
    state.voActiveChat &&
    (state.voRunning || []).some((r) => r.workerId === state.voActiveChat && r.status === 'running');
  const sendBtnIsStop = (state.busy && !state.virtualOffice) || (!!(voWorkerBusy && !(draft || '').trim()));
  const review = getPendingReview();
  const modeLabel = state.chatMode === 'ask' ? 'Ask' : 'Agent';
  const effortLabel =
    state.effortLevel === 'low' ? 'Low' : state.effortLevel === 'high' ? 'High' : 'Medium';
  const placeholder = state.virtualOffice
    ? 'Assign another task (parallel)…'
    : state.chatMode === 'ask'
      ? 'Ask anything…'
      : 'Plan, search, build anything';

  const composer = el(`<div class="composer">
    <div class="composer-stack">
      ${
        review
          ? `<div class="review-bar" id="reviewBar">
        <button type="button" class="review-toggle" id="reviewToggle" aria-expanded="${state.reviewOpen ? 'true' : 'false'}">
          <span class="review-chevron${state.reviewOpen ? ' open' : ''}" aria-hidden="true"></span>
          <span class="review-summary"><strong>${review.n}</strong> file${review.n === 1 ? '' : 's'} <span class="add">+${review.add}</span> <span class="del">−${review.del}</span></span>
        </button>
        <div class="review-actions">
          <button type="button" class="review-reject" id="reviewReject">Reject</button>
          <button type="button" class="review-accept" id="reviewAccept">Accept</button>
        </div>
      </div>
      ${
        state.reviewOpen
          ? `<div class="review-list" id="reviewList"></div>`
          : ''
      }`
          : ''
      }
      <div class="input-surface">
        <div class="composer-images" id="composerImages"></div>
        <div class="input-wrap">
          <div class="input-highlight" id="inputHighlight" aria-hidden="true"></div>
          <textarea id="input" rows="1" placeholder="${escapeHtml(placeholder)}" spellcheck="false"></textarea>
        </div>
        <div class="input-footer">
          <div class="composer-tools">
            <div class="mode-menu-wrap">
              <button type="button" class="tool-pill" id="modeBtn" title="Mode">
                <span class="tool-infinity" aria-hidden="true">∞</span>
                <span>${escapeHtml(modeLabel)}</span>
                <span class="tool-caret" aria-hidden="true"></span>
              </button>
              ${
                state.modeMenu
                  ? `<div class="composer-pop mode-pop" id="modePop">
                <button type="button" class="pop-item${state.chatMode === 'agent' ? ' on' : ''}" data-mode="agent"><span class="tool-infinity">∞</span> Agent<span class="pop-desc">Edit, run, ship</span></button>
                <button type="button" class="pop-item${state.chatMode === 'ask' ? ' on' : ''}" data-mode="ask"><span class="pop-ask">?</span> Ask<span class="pop-desc">Answers only</span></button>
              </div>`
                  : ''
              }
            </div>
            <div class="effort-menu-wrap">
              <button type="button" class="tool-pill" id="effortBtn" title="Effort (UI preview)">
                <span>${escapeHtml(effortLabel)}</span>
                <span class="tool-caret" aria-hidden="true"></span>
              </button>
              ${state.effortMenu ? '<div class="composer-pop effort-pop" id="effortPop"></div>' : ''}
            </div>
          </div>
          <div class="composer-actions">
            <input type="file" id="imageInput" accept="image/*" multiple hidden />
            <button type="button" class="icon-btn" id="imageBtn" title="Attach image">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4.5 16.5l4.2-4.2a1.2 1.2 0 011.7 0L14 16l2.1-2.1a1.2 1.2 0 011.7 0l2.7 2.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="send-btn${sendBtnIsStop ? ' send-btn-stop' : ''}" id="send" type="button" title="${
              sendBtnIsStop ? 'Stop' : 'Send'
            }" aria-label="${sendBtnIsStop ? 'Stop' : 'Send'}">
              ${
                sendBtnIsStop
                  ? '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
                  : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>`);
  app.appendChild(composer);

  if (review && state.reviewOpen) {
    const list = composer.querySelector('#reviewList');
    if (list) {
      for (const f of review.files) {
        const row = el(`<button type="button" class="review-file">
          <span class="review-file-name">${escapeHtml(f.name || f.path)}</span>
          <span class="file-stats"><span class="add">+${Number(f.additions) || 0}</span><span class="del">−${
            Number(f.deletions) || 0
          }</span></span>
        </button>`);
        row.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: f.path }));
        list.appendChild(row);
      }
    }
  }
  const reviewToggle = composer.querySelector('#reviewToggle');
  if (reviewToggle) {
    reviewToggle.addEventListener('click', () => {
      state.reviewOpen = !state.reviewOpen;
      render({ keepFocus: true });
    });
  }
  const reviewReject = composer.querySelector('#reviewReject');
  if (reviewReject) {
    reviewReject.addEventListener('click', () => vscode.postMessage({ type: 'revertAll' }));
  }
  const reviewAccept = composer.querySelector('#reviewAccept');
  if (reviewAccept) {
    reviewAccept.addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
  }

  const modeBtn = composer.querySelector('#modeBtn');
  if (modeBtn) {
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.modeMenu = !state.modeMenu;
      state.effortMenu = false;
      render({ keepFocus: true });
    });
  }
  composer.querySelectorAll('#modePop .pop-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.chatMode = btn.getAttribute('data-mode') === 'ask' ? 'ask' : 'agent';
      state.modeMenu = false;
      render({ keepFocus: true });
    });
  });

  const effortBtn = composer.querySelector('#effortBtn');
  if (effortBtn) {
    effortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.effortMenu = !state.effortMenu;
      state.modeMenu = false;
      render({ keepFocus: true });
    });
  }
  const effortPop = composer.querySelector('#effortPop');
  if (effortPop) mountEffortPopup(effortPop);

  const imageInput = composer.querySelector('#imageInput');
  const imageBtn = composer.querySelector('#imageBtn');
  if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', () => {
      const files = Array.from(imageInput.files || []);
      void addComposerImages(files);
      imageInput.value = '';
    });
  }
  renderComposerImages(composer.querySelector('#composerImages'));

  const input = composer.querySelector('#input');
  const inputHighlight = composer.querySelector('#inputHighlight');
  input.value = draft || '';
  state.draft = input.value;
  syncInputHighlight(input, inputHighlight);

  input.addEventListener('input', () => {
    state.draft = input.value;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 168) + 'px';
    if (inputHighlight) inputHighlight.style.height = input.style.height;
    inputTypingUntil = Date.now() + 500;
    syncSendButton();
    syncInputHighlight(input, inputHighlight);
    updateAtMention(input);
    clearTimeout(typingQuietTimer);
    typingQuietTimer = setTimeout(() => {
      if (!state.atMenu) render({ keepFocus: true });
    }, 520);
  });
  input.addEventListener('scroll', () => {
    if (inputHighlight) inputHighlight.scrollTop = input.scrollTop;
  });
  input.addEventListener('keydown', (e) => {
    if (state.atMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab')) {
      if (handleAtMenuKey(e, input)) return;
    }
  });
  // Prefetch open/workspace files for @ mentions
  if (!state.contextFiles.length) vscode.postMessage({ type: 'listContextFiles' });

  const atHost = composer.querySelector('.input-surface');
  if (state.atMenu) {
    const pop = renderAtMenu(input);
    if (pop && atHost) atHost.appendChild(pop);
  }
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type && item.type.indexOf('image') === 0) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void addComposerImages(files);
    }
  });

  const send = () => {
    if (state.busy && !state.virtualOffice) {
      vscode.postMessage({ type: 'abort' });
      return;
    }
    const text = input.value.trim();
    if (state.virtualOffice && voWorkerBusy && !text) {
      vscode.postMessage({ type: 'abortVo', workerId: state.voActiveChat });
      return;
    }
    const images = (state.composerImages || []).slice();
    if (!text && !images.length) return;
    input.value = '';
    state.draft = '';
    state.atMenu = false;
    state.composerImages = [];
    // Visible chat stays clean — Ask instructions / image placeholders never enter the bubble
    const displayText = text;
    const imagePreviews = images.map((img) => ({ name: img.name, dataUrl: img.dataUrl }));
    if (state.virtualOffice) {
      state.busy = false;
      state.phase = 'Assigning to a teammate…';
      render({ keepFocus: true });
      vscode.postMessage({
        type: 'send',
        text: displayText,
        mode: 'agent',
        effort: state.effortLevel,
        skipUserEcho: false,
      });
      return;
    }
    state.busy = true;
    state.phase = 'Planning next moves';
    state.messages.push({
      role: 'user',
      text: displayText,
      images: imagePreviews,
    });
    render({ keepFocus: true });
    vscode.postMessage({
      type: 'send',
      text: displayText,
      mode: state.chatMode,
      effort: state.effortLevel,
      skipUserEcho: true,
      hasImages: images.length > 0,
    });
  };
  composer.querySelector('#send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    send();
  });
  if (!keepFocus && !typing) input.focus();
  else if (typingId === 'input') {
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
  } else if (typing && typingId) {
    const node = document.getElementById(typingId);
    if (node) {
      node.focus();
      if (typeof node.selectionStart === 'number') node.selectionStart = node.selectionEnd = node.value.length;
    }
  }
}

function getPendingReview() {
  if (state.busy) return null;
  if (state.virtualOffice) {
    const run = state.voActiveChat
      ? (state.voRunning || []).find((r) => r.workerId === state.voActiveChat)
      : null;
    if (run && run.status === 'running') return null;
  }
  const filesMsg = [...state.messages].reverse().find((m) => m.role === 'files' && Array.isArray(m.files) && m.files.length);
  if (!filesMsg) return null;
  const files = filesMsg.files.filter((f) => f.status !== 'accepted' && f.status !== 'reverted');
  if (!files.length) return null;
  const add = files.reduce((s, f) => s + (Number(f.additions) || 0), 0);
  const del = files.reduce((s, f) => s + (Number(f.deletions) || 0), 0);
  return { files, n: files.length, add, del };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function addComposerImages(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && String(f.type || '').indexOf('image/') === 0);
  if (!files.length) return;
  const next = Array.isArray(state.composerImages) ? state.composerImages.slice() : [];
  for (const f of files.slice(0, 6)) {
    if (next.length >= 6) break;
    try {
      const dataUrl = await readFileAsDataUrl(f);
      next.push({
        id: 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: f.name || 'image.png',
        mime: f.type || 'image/png',
        dataUrl,
      });
    } catch {
      /* skip */
    }
  }
  state.composerImages = next;
  render({ keepFocus: true });
}

function renderComposerImages(node) {
  if (!node) return;
  node.innerHTML = '';
  const imgs = state.composerImages || [];
  if (!imgs.length) {
    node.style.display = 'none';
    return;
  }
  node.style.display = 'flex';
  for (const img of imgs) {
    const chip = el(`<div class="img-chip">
      <img alt="" src="${img.dataUrl}" />
      <button type="button" class="img-remove" title="Remove" aria-label="Remove">×</button>
    </div>`);
    chip.querySelector('.img-remove').addEventListener('click', () => {
      state.composerImages = (state.composerImages || []).filter((x) => x.id !== img.id);
      render({ keepFocus: true });
    });
    node.appendChild(chip);
  }
}

function renderUserBubble(m) {
  const bubble = el(`<div class="bubble user"></div>`);
  if (Array.isArray(m.images) && m.images.length) {
    const row = el('<div class="bubble-images"></div>');
    for (const img of m.images) {
      if (!img || !img.dataUrl) continue;
      row.appendChild(el(`<img class="bubble-img" alt="${escapeHtml(img.name || 'image')}" src="${img.dataUrl}" />`));
    }
    bubble.appendChild(row);
  }
  if (m.text) {
    const p = el('<div class="bubble-text"></div>');
    p.innerHTML = escapeHtml(String(m.text)).replace(
      /(^|[\s])(@[^\s@]+)/g,
      (full, sp, token) => sp + '<span class="at-token">' + token + '</span>',
    );
    bubble.appendChild(p);
  }
  return bubble;
}

function atMentionMatch(value, caret) {
  const left = String(value || '').slice(0, typeof caret === 'number' ? caret : String(value || '').length);
  const m = left.match(/(^|[\s])@([^\s@]*)$/);
  if (!m) return null;
  return { query: m[2] || '', start: left.length - (m[2] || '').length - 1 };
}

function syncInputHighlight(input, highlight) {
  if (!input || !highlight) return;
  const raw = String(input.value || '');
  // Color completed @file tokens yellow; leave plain text white
  const html = escapeHtml(raw).replace(
    /(^|[\s])(@[^\s@]+)/g,
    (m, sp, token) => sp + '<span class="at-token">' + token + '</span>',
  );
  highlight.innerHTML = html + (raw.endsWith('\n') ? ' ' : '');
  highlight.scrollTop = input.scrollTop;
}

function atKindLabel(kind) {
  if (kind === 'open') return 'Open';
  if (kind === 'recent') return 'Recent';
  if (kind === 'folder') return 'Folder';
  return 'File';
}

function atFileIcon(kind) {
  if (kind === 'folder') {
    return '<svg class="at-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 3.5A1.5 1.5 0 013 2h3.2l1.1 1.1H13A1.5 1.5 0 0114.5 4.6v7.9A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5v-9z"/></svg>';
  }
  return '<svg class="at-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3.5 1.5A1.5 1.5 0 015 0h4.3L13 3.7V14.5A1.5 1.5 0 0111.5 16h-6A1.5 1.5 0 014 14.5v-13zm5 .7V4h2.7L8.5 2.2z"/></svg>';
}

function filteredContextFiles() {
  const q = String(state.atQuery || '').toLowerCase();
  const files = Array.isArray(state.contextFiles) ? state.contextFiles : [];
  return files
    .filter((f) => {
      if (!q) return true;
      return String(f.name || '').toLowerCase().includes(q) || String(f.path || '').toLowerCase().includes(q);
    })
    .slice(0, 14);
}

function updateAtMention(input) {
  const caret = input.selectionStart;
  const hit = atMentionMatch(input.value, caret);
  if (!hit) {
    if (state.atMenu) {
      state.atMenu = false;
      state.atQuery = '';
      const old = document.getElementById('atMenu');
      if (old) old.remove();
    }
    return;
  }
  state.atQuery = hit.query;
  state.atMenu = true;
  if (!state._atFetchAt || Date.now() - state._atFetchAt > 800) {
    state._atFetchAt = Date.now();
    vscode.postMessage({ type: 'listContextFiles' });
  }
  const host = input.closest('.input-surface');
  let pop = document.getElementById('atMenu');
  if (pop) pop.remove();
  pop = renderAtMenu(input);
  if (pop && host) host.appendChild(pop);
}

function renderAtMenu(input) {
  const items = filteredContextFiles();
  const pop = el(`<div class="at-menu" id="atMenu"></div>`);
  if (!items.length) {
    pop.appendChild(el('<div class="at-empty">No matching files</div>'));
    return pop;
  }
  let lastGroup = '';
  items.forEach((f, i) => {
    const group = atKindLabel(f.kind);
    if (group !== lastGroup) {
      lastGroup = group;
      pop.appendChild(el(`<div class="at-section">${escapeHtml(group)}</div>`));
    }
    const pathShown = f.path && f.path !== f.name ? f.path : '';
    const row = el(`<button type="button" class="at-item${i === 0 ? ' on' : ''}" data-path="${escapeHtml(f.path)}">
      ${atFileIcon(f.kind)}
      <span class="at-meta">
        <span class="at-name">${escapeHtml(f.name || f.path)}</span>
        ${pathShown ? `<span class="at-path">${escapeHtml(pathShown)}</span>` : ''}
      </span>
    </button>`);
    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      insertAtMention(input, f);
    });
    pop.appendChild(row);
  });
  return pop;
}

function insertAtMention(input, file) {
  const caret = input.selectionStart;
  const hit = atMentionMatch(input.value, caret);
  if (!hit) return;
  const token = '@' + (file.name || file.path);
  const before = input.value.slice(0, hit.start);
  const after = input.value.slice(caret);
  input.value = before + token + ' ' + after;
  state.draft = input.value;
  state.atMenu = false;
  state.atQuery = '';
  const pos = (before + token + ' ').length;
  input.focus();
  input.selectionStart = input.selectionEnd = pos;
  const old = document.getElementById('atMenu');
  if (old) old.remove();
  syncInputHighlight(input, document.getElementById('inputHighlight'));
}

function handleAtMenuKey(e, input) {
  const pop = document.getElementById('atMenu');
  if (!pop) return false;
  const items = Array.from(pop.querySelectorAll('.at-item'));
  if (!items.length) return false;
  let idx = items.findIndex((n) => n.classList.contains('on'));
  if (idx < 0) idx = 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[idx].classList.remove('on');
    idx = (idx + 1) % items.length;
    items[idx].classList.add('on');
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[idx].classList.remove('on');
    idx = (idx - 1 + items.length) % items.length;
    items[idx].classList.add('on');
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const path = items[idx].getAttribute('data-path');
    const nameEl = items[idx].querySelector('.at-name');
    const file = (state.contextFiles || []).find((f) => f.path === path) || {
      path,
      name: (nameEl && nameEl.textContent) || path,
    };
    insertAtMention(input, file);
    return true;
  }
  return false;
}

function mountEffortPopup(root) {
  // Faithful port of Effort Power-Level Slider.html (same liquid animation)
  const pct =
    typeof state.effortPct === 'number'
      ? state.effortPct
      : state.effortLevel === 'low'
        ? 8
        : state.effortLevel === 'high'
          ? 88
          : 50;
  root.innerHTML = `<div class="effort-card">
    <div class="effort-head">
      <h1 class="effort-title">Effort <span id="effortModel">OLKIL</span></h1>
      <div class="effort-tag" id="effortTag">Low</div>
    </div>
    <div class="effort-scale"><span>Faster</span><span>Smarter</span></div>
    <div class="effort-track" id="effortTrack">
      <canvas id="effortCanvas"></canvas>
      <input type="range" id="effortSlider" min="0" max="100" value="${pct}" step="1" aria-label="Effort level" />
    </div>
    <div class="effort-helper" id="effortHelper">Quick, lightweight responses. Minimal compute, minimal drama.</div>
    <div class="effort-presets">
      <button type="button" class="effort-preset" data-pct="8">Low</button>
      <button type="button" class="effort-preset" data-pct="50">Medium</button>
      <button type="button" class="effort-preset" data-pct="90">High</button>
    </div>
  </div>`;

  const slider = root.querySelector('#effortSlider');
  const track = root.querySelector('#effortTrack');
  const levelTag = root.querySelector('#effortTag');
  const helper = root.querySelector('#effortHelper');
  const modelName = root.querySelector('#effortModel');
  const canvas = root.querySelector('#effortCanvas');
  const ctx = canvas.getContext('2d');
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const names = ['OLKIL', 'OLKIL', 'OLKIL Pro', 'OLKIL Pro', 'OLKIL Max'];

  let W = 0;
  let H = 0;
  let DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    const rect = track.getBoundingClientRect();
    W = canvas.width = Math.max(1, Math.floor(rect.width * DPR));
    H = canvas.height = Math.max(1, Math.floor(rect.height * DPR));
  }
  resize();
  window.addEventListener('resize', resize);

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }
  function noise1(x, t) {
    return Math.sin(x * 0.9 + t) * 0.5 + Math.sin(x * 2.3 - t * 1.6) * 0.3 + Math.sin(x * 5.1 + t * 2.4) * 0.2;
  }
  function mix(c1, c2, t) {
    return c1.map((v, i) => v + (c2[i] - v) * t);
  }
  function energyAt(pct) {
    if (pct < 0.34) {
      const t = pct / 0.34;
      return 0.04 + t * 0.14;
    }
    if (pct < 0.72) {
      const t = (pct - 0.34) / 0.38;
      return 0.18 + t * 0.4;
    }
    const t = (pct - 0.72) / 0.28;
    return 0.58 + t * 1.1;
  }
  function colorAt(p) {
    const low = [108, 111, 240];
    const mid = [182, 92, 240];
    const high = [255, 90, 54];
    const high2 = [255, 176, 32];
    if (p < 0.5) {
      const t = p / 0.5;
      return low.map((v, i) => v + (mid[i] - v) * t);
    }
    const t = (p - 0.5) / 0.5;
    const base = mid.map((v, i) => v + (high[i] - v) * t);
    if (p > 0.85) {
      const t2 = (p - 0.85) / 0.15;
      return base.map((v, i) => v + (high2[i] - v) * t2);
    }
    return base;
  }

  let bubbles = [];
  function spawnBubble(fillW) {
    bubbles.push({
      x: rand(0, Math.max(fillW, 1)),
      y: H + rand(0, 6),
      vx: rand(-0.15, 0.15),
      vy: rand(-0.9, -0.4),
      r: rand(0.8, 2.2) * DPR,
      life: 1,
    });
  }
  let splashes = [];
  function spawnSplash(x) {
    splashes.push({
      x,
      y: H * 0.15,
      vx: rand(-0.8, 0.8),
      vy: rand(-2.2, -1.0),
      r: rand(0.7, 1.6) * DPR,
      life: 1,
    });
  }

  let power = pct / 100;
  let targetPower = pct / 100;
  let time = 0;
  let raf = 0;
  let lastFrame = 0;

  function draw(now) {
    // Cap ~36fps — same look, less lag in the sidebar webview
    if (now - lastFrame < 28) {
      raf = requestAnimationFrame(draw);
      return;
    }
    lastFrame = now;

    ctx.clearRect(0, 0, W, H);
    power += (targetPower - power) * 0.14;
    const energy = energyAt(power);
    time += 0.03 + energy * 0.1;
    const col = colorAt(power);
    const fillW = W * power;

    if (fillW > 1) {
      const grad = ctx.createLinearGradient(0, 0, fillW, 0);
      grad.addColorStop(0, `rgba(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])},0.30)`);
      grad.addColorStop(1, `rgba(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])},0.6)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, fillW, H);
    }

    if (!prefersReduced && fillW > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, fillW, H);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';

      const core = mix(col, [255, 255, 255], 0.6);
      const midC = mix(col, [255, 255, 255], 0.15);
      const edge = mix(col, [10, 0, 20], 0.35);
      const coreS = `${Math.round(core[0])},${Math.round(core[1])},${Math.round(core[2])}`;
      const midS = `${Math.round(midC[0])},${Math.round(midC[1])},${Math.round(midC[2])}`;
      const edgeS = `${Math.round(edge[0])},${Math.round(edge[1])},${Math.round(edge[2])}`;

      // Coarser step + single path fill (was O(n) gradients — main lag source)
      const step = Math.max(6, Math.round(6 * DPR));
      const baseline = H * (0.42 + Math.min(energy, 1) * 0.22);
      const amplitude = H * 0.16 * energy;
      const surface = [];
      for (let x = 0; x <= fillW; x += step) {
        const nx = (x / W) * 7;
        const w = noise1(nx, time) * 0.6 + noise1(nx * 2.3 + 30, time * 1.8) * 0.4;
        let y1 = H - (baseline + w * amplitude);
        y1 = Math.max(H * 0.04, Math.min(H, y1));
        surface.push([x, y1]);
      }
      if (surface.length) {
        ctx.beginPath();
        ctx.moveTo(0, H);
        ctx.lineTo(surface[0][0], surface[0][1]);
        for (let i = 1; i < surface.length; i++) ctx.lineTo(surface[i][0], surface[i][1]);
        ctx.lineTo(fillW, H);
        ctx.closePath();
        const body = ctx.createLinearGradient(0, H, 0, H * 0.15);
        body.addColorStop(0, `rgba(${coreS},0.95)`);
        body.addColorStop(0.45, `rgba(${midS},0.75)`);
        body.addColorStop(0.85, `rgba(${edgeS},0.35)`);
        body.addColorStop(1, `rgba(${edgeS},0)`);
        ctx.fillStyle = body;
        ctx.fill();

        ctx.beginPath();
        surface.forEach(([x, y1], i) => (i === 0 ? ctx.moveTo(x, y1) : ctx.lineTo(x, y1)));
        ctx.strokeStyle = `rgba(255,255,255,${0.55 + energy * 0.3})`;
        ctx.lineWidth = (1.5 + energy * 1.5) * DPR;
        ctx.shadowColor = `rgba(${coreS},0.85)`;
        ctx.shadowBlur = (3 + energy * 8) * DPR;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      const desiredBubbles = Math.round(4 + Math.min(energy, 1) * 10);
      if (bubbles.length < desiredBubbles) spawnBubble(fillW);
      if (bubbles.length > desiredBubbles) bubbles.length = desiredBubbles;
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      for (const b of bubbles) {
        b.x += b.vx + Math.sin(time * 2 + b.y) * 0.15;
        b.y += b.vy * (0.6 + energy * 1.6);
        b.life -= 0.012 + energy * 0.008;
        if (b.life <= 0 || b.y < 0) {
          b.x = rand(0, Math.max(fillW, 1));
          b.y = H + rand(0, 6);
          b.vy = rand(-0.9, -0.4);
          b.life = 1;
        }
        ctx.globalAlpha = Math.max(0, b.life) * 0.7;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (energy > 1 && Math.random() < (energy - 1) * 0.55) spawnSplash(rand(0, fillW));
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i];
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 0.03;
        s.life -= 0.025;
        if (s.life <= 0) {
          splashes.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.fillStyle = `rgba(${coreS},${s.life})`;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    raf = requestAnimationFrame(draw);
  }

  function update(v) {
    const p = v / 100;
    targetPower = p;
    state.effortPct = v;
    state.effortLevel = p < 0.34 ? 'low' : p < 0.72 ? 'medium' : 'high';
    const col = colorAt(p);
    const rgb = `rgb(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])})`;
    const rgba = (a) => `rgba(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])},${a})`;
    track.style.setProperty('--effort-thumb', rgb);
    track.style.setProperty('--effort-glow', rgba(0.35 + p * 0.5));
    modelName.style.color = rgb;
    let label;
    let help;
    let tagBg;
    if (p < 0.34) {
      label = 'Low';
      tagBg = rgba(0.18);
      help = 'Quick, lightweight responses. Minimal compute, minimal drama.';
    } else if (p < 0.72) {
      label = 'Medium';
      tagBg = rgba(0.22);
      help = 'Balanced reasoning with noticeably more depth. Worth the extra second.';
    } else {
      label = 'High';
      tagBg = rgba(0.28);
      help = 'Maximum reasoning, maximum compute. Full send — this is the model thinking as hard as it can.';
    }
    levelTag.textContent = label;
    levelTag.style.color = rgb;
    levelTag.style.background = tagBg;
    levelTag.style.boxShadow = p > 0.72 ? `0 0 18px ${rgba(0.45)}` : 'none';
    helper.textContent = help;
    root.querySelector('.effort-card').style.boxShadow = p > 0.72 ? `0 0 ${20 + p * 50}px ${rgba(0.16)}` : 'none';
    const idx = Math.min(names.length - 1, Math.floor(p * names.length));
    modelName.textContent = names[idx];
    const pill = document.querySelector('#effortBtn span:first-child');
    if (pill) pill.textContent = label;
  }

  raf = requestAnimationFrame(draw);
  slider.addEventListener('input', (e) => update(+e.target.value));
  root.querySelectorAll('.effort-preset').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = Number(btn.getAttribute('data-pct') || 50);
      slider.value = String(v);
      update(v);
    });
  });
  update(+slider.value);
  root._effortCleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
}

function hasOpenLiveStep() {
  const afterUser = lastUserIndex();
  for (let i = state.messages.length - 1; i > afterUser; i--) {
    const m = state.messages[i];
    if (m.role !== 'activity' || m.done || isNoiseActivity(m)) continue;
    return true;
  }
  return false;
}

/** While Stop is armed and no live tool card, always show a working cue. */
function shouldShowWorkingPhase() {
  if (hasOpenLiveStep()) return false;
  if (state.virtualOffice) {
    if (!state.voActiveChat) return false;
    const run = (state.voRunning || []).find((r) => r.workerId === state.voActiveChat);
    return !!(run && run.status === 'running');
  }
  return !!state.busy;
}

function workingPhaseLabel() {
  const p = String(state.phase || '').trim();
  if (p) return p;
  return state.virtualOffice ? 'Working…' : 'Planning next moves';
}

function ensureWorkingPhase() {
  if (!shouldShowWorkingPhase()) return;
  if (!String(state.phase || '').trim()) {
    state.phase = state.virtualOffice ? 'Working…' : 'Planning next moves';
  }
}

function isNoiseActivity(a) {
  const label = String((a && a.label) || '').trim();
  const kind = String((a && a.kind) || '');
  if (kind === 'status' || kind === 'todo') return true;
  if (/^(Working|Thought|Thinking|Writing reply|Waiting|Continuing)/i.test(label)) return true;
  if (/^(Using tools|Running task)$/i.test(label)) return true;
  if (kind === 'tool' && /^(Using tools|Running task|Using tool)/i.test(label)) return true;
  if (/^\d+\s*todos?$/i.test(label)) return true;
  if (/todos?$/i.test(label) && label.length < 24) return true;
  return false;
}

function activityLine(a) {
  const path = shortPath(a.file || a.detail || a.title || '') || 'file';
  if (a.kind === 'edit') return 'Edited ' + path;
  if (a.kind === 'create') return 'Created ' + path;
  if (a.kind === 'read') return 'Read ' + path;
  if (a.kind === 'search') return 'Searched files ' + cleanActivityPath(a.detail || a.title || 'workspace');
  if (a.kind === 'bash') return a.command || a.detail || a.label || 'command';
  if (a.line) return String(a.line).replace(/\bAction\//gi, '').replace(/\baction\//gi, '');
  return String(a.label || a.detail || 'Step').replace(/\bAction\//gi, '');
}

function editsSummary(items) {
  const uniq = uniqueByLine(items);
  const n = uniq.length;
  if (n === 1) return activityLine(uniq[0]);
  const created = uniq.filter((a) => a.kind === 'create').length;
  const edited = n - created;
  if (created && !edited) return 'Created ' + created + ' file' + (created === 1 ? '' : 's');
  if (edited && !created) return 'Edited ' + edited + ' file' + (edited === 1 ? '' : 's');
  return 'Updated ' + n + ' files';
}

function renderEditsGroup(items) {
  if (items.length === 1) return renderSimpleStep(items[0], false);
  const id = 'e-' + items.map((a) => a.id || activityLine(a)).join('|').slice(0, 80);
  const open = state.activityOpen[id] === true;
  const box = el(`<div class="explore-group${open ? ' open' : ''}">
    <button type="button" class="explore-toggle">
      <span class="explore-summary">${escapeHtml(editsSummary(items))}</span>
      <span class="explore-chevron" aria-hidden="true"></span>
    </button>
    <div class="explore-list"></div>
  </div>`);
  const list = box.querySelector('.explore-list');
  if (open) {
    for (const a of items) {
      const row = el(`<div class="explore-item">${escapeHtml(activityLine(a))}</div>`);
      if (a.file) {
        row.classList.add('clickable');
        row.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: a.file }));
      }
      list.appendChild(row);
    }
  } else {
    list.remove();
  }
  box.querySelector('.explore-toggle').addEventListener('click', () => {
    state.activityOpen[id] = !open;
    render({ keepFocus: true });
  });
  return box;
}

function isExploreKind(kind) {
  return kind === 'search' || kind === 'read' || kind === 'web';
}

function renderInkStage(ink) {
  const action = ink.action === 'create' ? 'Creating' : ink.action === 'delete' ? 'Removing' : 'Updating';
  const stage = el(`<div class="ink-stage" data-action="${escapeHtml(ink.action || 'edit')}">
    <div class="ink-head">
      <span class="ink-pulse" aria-hidden="true"></span>
      <div class="ink-head-copy">
        <div class="ink-action">${escapeHtml(action)} <strong>${escapeHtml(ink.name || 'file')}</strong></div>
        <div class="ink-meters">
          <span class="add" data-count="${Number(ink.additions) || 0}">+0</span>
          <span class="del" data-count="${Number(ink.deletions) || 0}">−0</span>
        </div>
      </div>
    </div>
    <div class="ink-river"></div>
  </div>`);
  const river = stage.querySelector('.ink-river');
  const lines = Array.isArray(ink.lines) ? ink.lines : [];
  lines.slice(0, 28).forEach((line, i) => {
    const typ = line.type === 'del' ? 'del' : 'add';
    const prefix = typ === 'add' ? '+' : '−';
    const row = el(
      `<div class="ink-line ${typ}" style="--i:${i}"><span class="diff-prefix">${prefix}</span>${escapeHtml(String(line.text || '').slice(0, 140))}</div>`,
    );
    river.appendChild(row);
  });
  // Count-up after mount
  requestAnimationFrame(() => {
    stage.querySelectorAll('.ink-meters [data-count]').forEach((node) => {
      animateCount(node, Number(node.getAttribute('data-count')) || 0, node.classList.contains('del') ? '−' : '+');
    });
  });
  if (ink.path) {
    stage.style.cursor = 'pointer';
    stage.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: ink.path }));
  }
  return stage;
}

function animateCount(node, target, prefix) {
  const end = Math.max(0, target);
  if (end === 0) {
    node.textContent = prefix + '0';
    return;
  }
  const ms = Math.min(900, 280 + end * 12);
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = prefix + Math.round(end * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function groupActivities(acts) {
  const groups = [];
  let explore = null;
  let edits = null;
  const flushExplore = () => {
    if (explore) {
      explore.items = uniqueByLine(explore.items);
      if (explore.items.length) groups.push(explore);
      explore = null;
    }
  };
  const flushEdits = () => {
    if (edits) {
      edits.items = uniqueByLine(edits.items);
      if (edits.items.length === 1) groups.push({ type: 'single', items: edits.items });
      else if (edits.items.length > 1) groups.push(edits);
      edits = null;
    }
  };
  for (const a of acts) {
    if (a.kind === 'bash') {
      flushExplore();
      flushEdits();
      groups.push({ type: 'command', items: [a] });
      continue;
    }
    if (isExploreKind(a.kind)) {
      flushEdits();
      if (!explore) explore = { type: 'explore', items: [] };
      explore.items.push(a);
      continue;
    }
    if (a.kind === 'edit' || a.kind === 'create') {
      flushExplore();
      if (!edits) edits = { type: 'edits', items: [] };
      edits.items.push(a);
      continue;
    }
    flushExplore();
    flushEdits();
    const line = activityLine(a);
    const last = groups[groups.length - 1];
    if (last && last.type === 'single' && activityLine(last.items[0]) === line) {
      last.items[0] = a;
      continue;
    }
    groups.push({ type: 'single', items: [a] });
  }
  flushExplore();
  flushEdits();
  return groups;
}

function uniqueByLine(items) {
  const seen = new Set();
  const out = [];
  for (const a of items) {
    const key = activityLine(a).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function dedupeActivities(acts) {
  const out = [];
  const indexByFp = new Map();
  for (const a of acts) {
    const fp = activityFingerprint(a);
    const line = activityLine(a);
    if (fp && indexByFp.has(fp)) {
      out[indexByFp.get(fp)] = { ...out[indexByFp.get(fp)], ...a };
      continue;
    }
    if (out.length && activityLine(out[out.length - 1]) === line) {
      out[out.length - 1] = { ...out[out.length - 1], ...a };
      continue;
    }
    if (fp) indexByFp.set(fp, out.length);
    out.push(a);
  }
  return out;
}

function exploreSummary(items) {
  const uniq = uniqueByLine(items);
  const searches = uniq.filter((a) => a.kind === 'search').length;
  const reads = uniq.filter((a) => a.kind === 'read' || a.kind === 'web').length;
  if (searches && !reads) return 'Explored ' + searches + ' search' + (searches === 1 ? '' : 'es');
  if (reads && !searches) return 'Explored ' + reads + ' file' + (reads === 1 ? '' : 's');
  const focus = uniq.find((a) => a.kind === 'read' && (a.title || a.file));
  if (focus && searches) {
    return 'Explored ' + (focus.title || shortPath(focus.file)) + ', ' + searches + ' search' + (searches === 1 ? '' : 'es');
  }
  return 'Explored ' + uniq.length + ' step' + (uniq.length === 1 ? '' : 's');
}

function renderAgentTimeline(acts) {
  const wrap = el('<div class="agent-feed"></div>');
  const normalized = acts.map((a) => {
    if (a.kind) return a;
    const line = String(a.line || a.label || '');
    if (/^Read\b/i.test(line)) return { ...a, kind: 'read' };
    if (/^(Edited|Editing)\b/i.test(line)) return { ...a, kind: 'edit' };
    if (/^(Created|Creating|Wrote|Writing)\b/i.test(line)) return { ...a, kind: 'create' };
    if (/^Searched\b|^Searching\b/i.test(line)) return { ...a, kind: 'search' };
    return a;
  });
  const cleaned = dedupeActivities(normalized.filter((a) => !isNoiseActivity(a)));
  // Guarantee a single live step; everything else is settled history.
  let liveIdx = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (!cleaned[i].done) {
      liveIdx = i;
      break;
    }
  }
  const done = [];
  let live = null;
  cleaned.forEach((a, i) => {
    if (i === liveIdx) live = a;
    else done.push({ ...a, done: true });
  });
  // Hollow create/edit with no real file must never stay as animating live card
  if (live && /^(create|edit)$/.test(String(live.kind || ''))) {
    const file = String(live.file || live.detail || live.title || '')
      .replace(/\\/g, '/')
      .trim()
      .toLowerCase();
    if (!file || file === 'file') {
      done.push({ ...live, done: true, hide: true });
      live = null;
    }
  }
  for (const g of groupActivities(done.filter((a) => !a.hide))) {
    if (g.type === 'explore') wrap.appendChild(renderExploreGroup(g.items));
    else if (g.type === 'edits') wrap.appendChild(renderEditsGroup(g.items));
    else if (g.type === 'command') wrap.appendChild(renderCommandBox(g.items[0], false));
    else wrap.appendChild(renderSimpleStep(g.items[0], false));
  }
  if (live) {
    if (live.kind === 'bash') wrap.appendChild(renderCommandBox(live, true));
    else if (isExploreKind(live.kind) || live.kind === 'edit' || live.kind === 'create' || live.kind === 'tool') {
      wrap.appendChild(renderLiveTask(live));
    } else {
      wrap.appendChild(renderSimpleStep(live, true));
    }
  }
  return wrap;
}

function renderExploreGroup(items) {
  const id = 'g-' + items.map((a) => a.id || activityLine(a)).join('|').slice(0, 80);
  const open = state.activityOpen[id] === true;
  const box = el(`<div class="explore-group${open ? ' open' : ''}">
    <button type="button" class="explore-toggle">
      <span class="explore-summary">${escapeHtml(exploreSummary(items))}</span>
      <span class="explore-chevron" aria-hidden="true"></span>
    </button>
    <div class="explore-list"></div>
  </div>`);
  const list = box.querySelector('.explore-list');
  if (open) {
    for (const a of items) {
      const row = el(`<div class="explore-item">${escapeHtml(activityLine(a))}</div>`);
      if (a.file) {
        row.classList.add('clickable');
        row.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: a.file }));
      }
      list.appendChild(row);
    }
  } else {
    list.remove();
  }
  box.querySelector('.explore-toggle').addEventListener('click', () => {
    state.activityOpen[id] = !open;
    render({ keepFocus: true });
  });
  return box;
}

function shellTokens(cmd) {
  const raw = String(cmd || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'command';
  // Prefer showing PowerShell/cmdlet-style tokens when present
  const parts = raw.split(/[|;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const names = parts
      .map((p) => p.split(/\s+/)[0])
      .filter(Boolean)
      .slice(0, 6);
    if (names.length > 1) return names.join(', ');
  }
  return raw.length > 110 ? raw.slice(0, 107) + '…' : raw;
}

function renderCommandBox(a, live) {
  const text = shellTokens(a.command || a.detail || a.line || a.label || '');
  const box = el(`<div class="cmd-box${live ? ' live' : ''}" title="${escapeHtml(a.command || a.detail || '')}">
    <span class="cmd-prompt" aria-hidden="true">&gt;_</span>
    <span class="cmd-text">${escapeHtml(text)}</span>
    ${live ? '<span class="cmd-spinner" aria-hidden="true"></span>' : ''}
  </div>`);
  return box;
}

function renderLiveTask(a) {
  const badge =
    a.badge ||
    (a.kind === 'create' ? 'Writer' : a.kind === 'edit' ? 'Editor' : a.kind === 'bash' ? 'Shell' : 'Explorer');
  const title = liveTaskTitle(a);
  const verb =
    a.kind === 'create' || a.action === 'create'
      ? 'Creating'
      : a.kind === 'edit'
        ? 'Editing'
        : a.kind === 'read'
          ? 'Reading'
          : a.kind === 'search'
            ? 'Searching'
            : a.kind === 'web'
              ? 'Looking up'
              : 'Running';
  // Never show redundant "Action/file" subtitle — title already has the filename
  let subtitle = '';
  if (a.kind === 'search' && a.detail && a.detail !== title) {
    subtitle = String(a.detail).slice(0, 120);
  } else if (a.kind === 'bash' && a.command) {
    subtitle = String(a.command).slice(0, 120);
  }

  const card = el(`<div class="live-task" data-kind="${escapeHtml(a.kind || '')}">
    <span class="live-task-icon" aria-hidden="true">
      <span></span><span></span><span></span><span></span>
    </span>
    <div class="live-task-body">
      <div class="live-task-title">
        <span class="live-task-verb">${escapeHtml(verb)}</span>
        <strong>${escapeHtml(title)}</strong>
        <span class="live-task-badge">${escapeHtml(badge)}</span>
      </div>
      ${subtitle ? `<div class="live-task-sub">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  </div>`);
  if (a.file) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: cleanActivityPath(a.file) }));
  }
  return card;
}

function renderSimpleStep(a, live) {
  return el(`<div class="step-line${live ? ' live' : ''}">${escapeHtml(activityLine(a))}</div>`);
}

function waitLine(ls) {
  if (!state.busy) return null;
  let text = 'Waiting for agent…';
  if (ls && /continuing/i.test(ls.label || '')) text = 'Continuing remaining work…';
  else if (ls && /retry/i.test(ls.label || '')) text = 'Retrying…';
  else if (ls && /thinking/i.test(ls.label || '')) text = 'Thinking…';
  else if (ls && ls.kind === 'bash') text = 'Running command…';
  else if (ls && /edit/i.test(ls.label || '')) text = 'Applying edits…';
  else if (ls && /(search|read|explor)/i.test(ls.label || '')) text = 'Waiting for explorer…';
  return el(`<div class="wait-line">${escapeHtml(text)}</div>`);
}

function formatMarkdown(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = [];
  let listType = '';
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,]|$)/g, '$1<em>$2</em>');
  const flushList = () => {
    if (!list.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    out.push('<' + tag + '>' + list.map((item) => '<li>' + inline(item) + '</li>').join('') + '</' + tag + '>');
    list = [];
    listType = '';
  };
  const pushList = (type, item) => {
    if (listType && listType !== type) flushList();
    listType = type;
    list.push(item);
  };
  let fence = '';
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (fence) {
        out.push('<pre><code>' + escapeHtml(fence.replace(/^\n/, '')) + '</code></pre>');
        fence = '';
      } else {
        flushList();
        fence = '\n';
      }
      continue;
    }
    if (fence !== '') {
      fence += line + '\n';
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushList();
      out.push('<hr />');
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList();
      const n = heading[1].length;
      out.push('<h' + n + '>' + inline(heading[2].trim()) + '</h' + n + '>');
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      pushList('ol', ol[1]);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      pushList('ul', ul[1]);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    out.push('<p>' + inline(line) + '</p>');
  }
  if (fence) out.push('<pre><code>' + escapeHtml(fence.replace(/^\n/, '')) + '</code></pre>');
  flushList();
  return out.join('') || '<p></p>';
}

function fileCard(files) {
  const pending = files.filter((f) => f.status !== 'accepted' && f.status !== 'reverted');
  const n = files.length;
  const add = files.reduce((s, f) => s + (Number(f.additions) || 0), 0);
  const del = files.reduce((s, f) => s + (Number(f.deletions) || 0), 0);
  const created = files.filter((f) => f.action === 'create').length;
  const title =
    created === n && n > 0
      ? 'Created ' + n + ' file' + (n === 1 ? '' : 's')
      : created > 0
        ? 'Changed ' + n + ' file' + (n === 1 ? '' : 's')
        : 'Edited ' + n + ' file' + (n === 1 ? '' : 's');
  const wrap = el(`<div class="file-card">
    <div class="file-head">
      <span class="file-head-title">${escapeHtml(title)}</span>
      <span class="file-stats"><span class="add" data-count="${add}">+${add}</span><span class="del" data-count="${del}">−${del}</span></span>
      <div class="file-head-actions"></div>
    </div>
    <div class="file-list"></div>
  </div>`);
  const actions = wrap.querySelector('.file-head-actions');
  if (pending.length) {
    const undo = el('<button class="undo" type="button">Undo</button>');
    const keep = el('<button class="keep" type="button">Keep</button>');
    undo.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'revertAll' });
    });
    keep.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'acceptAll' });
    });
    actions.appendChild(undo);
    actions.appendChild(keep);
  }
  const list = wrap.querySelector('.file-list');
  for (const f of files) {
    const addN = Number(f.additions) || 0;
    const delN = Number(f.deletions) || 0;
    const streaming = !!f.live;
    const actionLabel = f.action === 'create' ? 'new' : f.action === 'delete' ? 'removed' : '';
    const row = el(`<div class="file-block${streaming ? ' file-streaming' : ''}">
      <button class="file-row" type="button">
        <span class="file-name">${escapeHtml(f.name || f.path)}${
          actionLabel ? `<span class="file-action-tag">${actionLabel}</span>` : ''
        }</span>
        <span class="file-stats"><span class="add">+${addN}</span><span class="del">−${delN}</span></span>
      </button>
      <div class="diff-preview"></div>
    </div>`);
    row.querySelector('.file-row').addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: f.path }));
    const preview = row.querySelector('.diff-preview');
    const lines = Array.isArray(f.preview) ? f.preview : [];
    let i = 0;
    for (const line of lines.slice(0, 10)) {
      const t = String(line.text || '');
      const typ = line.type || 'context';
      if (typ === 'gap') {
        preview.appendChild(el('<div class="diff-line gap">···</div>'));
        continue;
      }
      const prefix = typ === 'add' ? '+' : typ === 'del' ? '−' : ' ';
      preview.appendChild(
        el(
          `<div class="diff-line ${typ}${streaming ? ' cascade' : ''}" style="--i:${i}"><span class="diff-prefix">${prefix}</span>${escapeHtml(
            t.slice(0, 120),
          )}</div>`,
        ),
      );
      i += 1;
    }
    list.appendChild(row);
  }
  return wrap;
}

function hideRemoteQr() {
  const node = document.getElementById('remoteQr');
  if (node) node.remove();
}

function showRemoteQr(url) {
  hideRemoteQr();
  let img = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    img = qr.createDataURL(8, 4);
  } catch (e) {
    img = '';
  }
  const node = el(`<div class="qr-pop" id="remoteQr">
    <div class="qr-card">
      <button type="button" class="qr-x" id="qrClose" aria-label="Close">×</button>
      <strong>Scan to connect</strong>
      ${img ? `<img alt="" src="${img}" />` : '<p>Could not draw the code.</p>'}
      <p>Open OLKIL Remote on your phone and scan this code.</p>
    </div>
  </div>`);
  node.addEventListener('click', (e) => {
    if (e.target === node) hideRemoteQr();
  });
  node.querySelector('#qrClose').addEventListener('click', () => hideRemoteQr());
  document.body.appendChild(node);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'auth') {
    state.signedIn = !!msg.signedIn;
    state.user = msg.user;
    state.quota = msg.quota;
    state.engineReady = !!msg.engineReady;
    state.paid = !!msg.paid;
    state.chatOpen = !!msg.chatOpen || !!msg.signedIn;
    state.plans = Array.isArray(msg.plans) ? msg.plans : state.plans;
    state.models = Array.isArray(msg.models) ? msg.models : state.models;
    if (msg.modelId) state.modelId = msg.modelId;
    if (Array.isArray(msg.customs)) state.customs = msg.customs;
    if (typeof msg.virtualOffice === 'boolean') state.virtualOffice = msg.virtualOffice;
    if (typeof msg.pocketOn === 'boolean') state.pocketOn = msg.pocketOn;
    if (typeof msg.pocketCode === 'string') state.pocketCode = msg.pocketCode;
    if (typeof msg.pocketError === 'string') state.pocketError = msg.pocketError;
    if (typeof msg.remoteAccess === 'boolean') state.remoteAccess = msg.remoteAccess;
    if (msg.voAssignee) state.voAssignee = msg.voAssignee;
    if (Array.isArray(msg.voAssignees)) state.voAssignees = msg.voAssignees;
    if (Array.isArray(msg.voRunning)) state.voRunning = msg.voRunning;
    if (msg.voInspected) state.voInspected = msg.voInspected;
    if (msg.custom) {
      state.custom = {
        ...state.custom,
        id: msg.custom.id || state.custom.id,
        model: msg.custom.model || state.custom.model,
        baseUrl: msg.custom.baseUrl || state.custom.baseUrl,
        hasKey: !!msg.custom.hasKey,
      };
    }
    if (msg.modelId && String(msg.modelId).indexOf('custom:') === 0) {
      const id = String(msg.modelId).slice('custom:'.length);
      const hit = (state.customs || []).find((c) => c.id === id);
      if (hit) {
        state.custom = { ...state.custom, id: hit.id, model: hit.model, baseUrl: hit.baseUrl, hasKey: !!hit.hasKey };
        state.addingCustom = false;
      }
    }
    render({ keepFocus: true });
  } else if (msg.type === 'remoteQr') {
    if (msg.open && msg.url) showRemoteQr(String(msg.url));
    else hideRemoteQr();
  } else if (msg.type === 'pocket') {
    state.pocketOn = !!msg.pocketOn;
    state.pocketCode = msg.pocketCode || '';
    state.pocketError = msg.pocketError || '';
    render({ keepFocus: true });
  } else if (msg.type === 'voStatus') {
    if (typeof msg.virtualOffice === 'boolean') state.virtualOffice = msg.virtualOffice;
    if (msg.voAssignee) state.voAssignee = msg.voAssignee;
    if (Array.isArray(msg.voRunning)) state.voRunning = msg.voRunning;
    if (msg.voInspected) state.voInspected = msg.voInspected;
    // If the open teammate just finished in the office, kill leftover loaders
    if (activeVoFinished()) {
      forceThreadSettled();
      if (state.voActiveChat && state.voChats[state.voActiveChat]) {
        state.voChats[state.voActiveChat].phase = '';
        state.voChats[state.voActiveChat].messages = state.messages;
      }
      state.phase = '';
    }
    render({ keepFocus: true });
  } else if (msg.type === 'status' || msg.type === 'activity') {
    if (state.upgrade) return;
    const actWid = msg.voWorkerId || (state.virtualOffice ? state.voActiveChat : '');
    if (actWid && voWorkerFinished(actWid) && !msg.done) return;
    routeVoMessage(msg, () => {
      if (!state.virtualOffice) state.busy = true;
      const label = msg.label || msg.text || '';
      if (!label || /opening olkil|engine ready|preparing the coding engine/i.test(label)) return;
      const candidate = {
        role: 'activity',
        id: msg.id || 'working',
        label,
        detail: cleanActivityPath(msg.detail || ''),
        file: cleanActivityPath(msg.file || ''),
        kind: msg.kind || '',
        line: msg.line || '',
        command: msg.command || '',
        title: msg.title || '',
        badge: msg.badge || '',
        action: msg.action || '',
        done: !!msg.done || (actWid ? voWorkerFinished(actWid) : false),
      };
      if (isNoiseActivity(candidate)) return;
      // Live tool card replaces the phase line; when the step settles, restore the cue
      if (!candidate.done) {
        if (!state.virtualOffice) state.phase = '';
      } else if (state.busy || (state.virtualOffice && !voWorkerFinished(actWid))) {
        if (!state.phase) state.phase = state.virtualOffice ? 'Working…' : 'Planning next moves';
      }
      upsertMessage(candidate);
      ensureWorkingPhase();
    });
  } else if (msg.type === 'phase') {
    routeVoMessage(msg, () => {
      if (!state.virtualOffice) state.busy = true;
      const label = msg.label != null ? String(msg.label) : String(msg.text || 'Planning next moves');
      state.phase = label;
      if (state.voActiveChat && state.voChats[state.voActiveChat]) {
        state.voChats[state.voActiveChat].phase = label;
      }
    });
  } else if (msg.type === 'voOpenChat') {
    openVoChat(String(msg.workerId || ''), {
      fresh: !!msg.fresh,
      prompt: msg.prompt || '',
      workerName: msg.workerName || '',
      messages: Array.isArray(msg.messages) ? msg.messages : [],
      phase: msg.phase || '',
    });
    render({ keepFocus: true });
  } else if (msg.type === 'voParallel') {
    state.busy = false;
    // Clear stale "X working" on finished threads; only keep a soft hint if someone else is still running
    if (state.voActiveChat && state.voChats[state.voActiveChat]) {
      const active = (state.voRunning || []).find((r) => r.workerId === state.voActiveChat);
      if (!active || active.status !== 'running') {
        state.phase = '';
        state.voChats[state.voActiveChat].phase = '';
      }
    }
    const stillRunning = (state.voRunning || []).filter((r) => r.status === 'running');
    if (stillRunning.length && !state.phase) {
      state.phase = String(msg.label || 'Teammates working — send another task anytime');
    }
    render({ keepFocus: true });
  } else if (msg.type === 'voWorkerDone') {
    const wid = String(msg.workerId || '');
    if (Array.isArray(msg.voRunning)) state.voRunning = msg.voRunning;
    if (wid && state.voChats[wid]) {
      const prevMsgs = state.messages;
      const prevActive = state.voActiveChat;
      state.messages = state.voChats[wid].messages;
      forceThreadSettled();
      state.voChats[wid].messages = state.messages;
      state.voChats[wid].phase = '';
      if (prevActive === wid) {
        state.phase = '';
      } else {
        state.messages = prevMsgs;
      }
    }
    if (state.voActiveChat === wid) {
      forceThreadSettled();
      state.phase = '';
    }
    render({ keepFocus: true });
  } else if (msg.type === 'ink') {
    return;
  } else if (msg.type === 'liveStatus') {
    return;
  } else if (msg.type === 'files') {
    routeVoMessage(msg, () => {
      upsertFilesCard(Array.isArray(msg.files) ? msg.files : []);
      const hasFinal = state.messages.some((m) => m.role === 'assistant' && !m.live);
      if (hasFinal || activeVoFinished()) pinSummaryAtEnd();
    });
  } else if (msg.type === 'contextFiles') {
    state.contextFiles = Array.isArray(msg.files) ? msg.files : [];
    const inputEl = document.getElementById('input');
    if (state.atMenu && inputEl) {
      const host = inputEl.closest('.input-surface');
      const old = document.getElementById('atMenu');
      if (old) old.remove();
      const pop = renderAtMenu(inputEl);
      if (pop && host) host.appendChild(pop);
    }
  } else if (msg.type === 'user') {
    routeVoMessage(msg, () => {
      const last = state.messages[state.messages.length - 1];
      if (!(last && last.role === 'user' && last.text === msg.text)) {
        state.messages.push({ role: 'user', text: msg.text });
      }
      if (!state.virtualOffice) {
        state.busy = true;
        if (!state.phase) state.phase = 'Planning next moves';
      }
    });
  } else if (msg.type === 'assistant') {
    routeVoMessage(msg, () => {
      if (!state.virtualOffice) state.busy = true;
      pruneHollowActivities();
      settleThreadActivities();
      // Never blank the feed while Stop is active — restore planning cue between steps
      if (!state.virtualOffice) {
        state.phase = 'Planning next moves';
      } else if (state.voActiveChat && !voWorkerFinished(state.voActiveChat)) {
        if (!state.phase) state.phase = (state.voWorkerName || 'Teammate') + ' working';
      }
      if (activeVoFinished()) forceThreadSettled();
      upsertAssistant(msg.text, !!msg.live);
      ensureWorkingPhase();
    });
  } else if (msg.type === 'error') {
    routeVoMessage(msg, () => {
      state.busy = false;
      state.liveStatus = null;
      state.ink = null;
      state.phase = '';
      pruneHollowActivities();
      settleThreadActivities();
      state.messages.push({ role: 'error', text: msg.text });
    });
  } else if (msg.type === 'idle') {
    const settleIdle = () => {
      pruneHollowActivities();
      settleThreadActivities();
      for (const m of state.messages) {
        if (m.role === 'activity') {
          if (/^(Working|Thought|Thinking|Writing reply|Continuing)/i.test(m.label || '')) m.hide = true;
        }
        if (m.role === 'assistant') m.live = false;
        if (m.role === 'files' && Array.isArray(m.files)) {
          m.files = m.files.map((f) => ({ ...f, live: false }));
        }
      }
      state.messages = state.messages.filter((m) => !m.hide);
      pinSummaryAtEnd();
    };
    if (msg.voWorkerId && state.virtualOffice) {
      routeVoMessage(msg, () => {
        settleIdle();
        state.phase = '';
        if (state.voChats[msg.voWorkerId]) state.voChats[msg.voWorkerId].phase = '';
      });
      return;
    }
    state.busy = false;
    state.liveStatus = null;
    state.ink = null;
    if (!state.virtualOffice) state.phase = '';
    bindActiveVoMessages();
    settleIdle();
    if (state.voActiveChat && state.voChats[state.voActiveChat]) {
      state.voChats[state.voActiveChat].messages = state.messages;
      const active = (state.voRunning || []).find((r) => r.workerId === state.voActiveChat);
      if (!active || active.status !== 'running') {
        state.phase = '';
        state.voChats[state.voActiveChat].phase = '';
      }
    }
    if (state.virtualOffice) {
      const running = (state.voRunning || []).filter((r) => r.status === 'running');
      if (running.length && !state.phase && !state.voActiveChat) {
        state.phase =
          running.length === 1
            ? `${running[0].workerName} still working — send another task anytime`
            : `${running.length} teammates working — send another task anytime`;
      }
    }
    render({ keepFocus: true });
  } else if (msg.type === 'upgrade') {
    state.upgrade = true;
    state.upgradeReason = msg.reason || '';
    state.busy = false;
    state.liveStatus = null;
    state.ink = null;
    state.phase = '';
    state.messages = state.messages.filter((m) => m.role !== 'activity');
    render();
  } else if (msg.type === 'reset') {
    state.busy = false;
    state.liveStatus = null;
    state.ink = null;
    state.phase = '';
    state.messages = [];
    render();
  } else if (msg.type === 'loadHistory') {
    state.busy = false;
    state.liveStatus = null;
    state.ink = null;
    state.phase = '';
    state.upgrade = false;
    state.messages = [];
    for (const m of msg.messages || []) {
      const role = m.role || '';
      const text = m.content || m.text || '';
      if (!text) continue;
      if (role === 'user') state.messages.push({ role: 'user', text });
      else if (role === 'assistant') state.messages.push({ role: 'assistant', text, live: false });
      else if (role === 'error') state.messages.push({ role: 'error', text });
    }
    render();
  }
});

render();
vscode.postMessage({ type: 'ready' });
