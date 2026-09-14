const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const icon = app.getAttribute('data-icon') || '';

const state = {
  signedIn: false,
  user: null,
  quota: null,
  engineReady: false,
  paid: false,
  chatOpen: false,
  upgrade: false,
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
};

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

function upsertMessage(msg) {
  const afterUser = lastUserIndex();
  if (msg.role === 'activity') {
    const idx = state.messages.findIndex((m, i) => i > afterUser && m.role === 'activity' && m.id === msg.id);
    if (idx >= 0) {
      state.messages[idx] = { ...state.messages[idx], ...msg };
      return;
    }
    const asst = state.messages.findIndex((m, i) => i > afterUser && m.role === 'assistant');
    if (asst >= 0) state.messages.splice(asst, 0, msg);
    else state.messages.push(msg);
    return;
  }
  if (msg.role === 'files') {
    const idx = state.messages.findIndex((m, i) => i > afterUser && m.role === 'files');
    if (idx >= 0) state.messages[idx] = msg;
    else {
      const asst = state.messages.findIndex((m, i) => i > afterUser && m.role === 'assistant');
      if (asst >= 0) state.messages.splice(asst, 0, msg);
      else state.messages.push(msg);
    }
  }
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

function render(opts) {
  const keepFocus = opts && opts.keepFocus;
  const active = document.activeElement;
  const typingId = active && active.id;
  const typing = typingId === 'input' || typingId === 'cModel' || typingId === 'cBase' || typingId === 'cKey' || typingId === 'modelSearch';
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
      <span class="plan">${escapeHtml(planLabel() || (state.signedIn ? name : 'Sign in'))}</span>
    </div>`,
  );
  app.appendChild(top);
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
      const add = el(`<button type="button" class="model-option${state.modelId === 'custom' || state.addingCustom ? ' active' : ''}">Add custom…</button>`);
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

  const msgs = el('<div class="msgs"></div>');
  if (!state.messages.length) {
    msgs.appendChild(
      el(`<div class="hero">
        <h1>What should we ship?</h1>
        <p>OLKIL uses your open files and selection. Press Ctrl+L / Cmd+L anytime.</p>
      </div>`),
    );
  } else {
    const pending = [];
    const flushActs = () => {
      const vis = pending.filter((a) => !(a.done && /^(Working|Thought|Writing)/i.test(a.label || '')));
      pending.length = 0;
      let lastLive = -1;
      vis.forEach((a, i) => {
        if (!a.done) lastLive = i;
      });
      vis.forEach((a, i) => {
        const live = i === lastLive;
        msgs.appendChild(
          el(
            `<div class="activity${live ? '' : ' done'}"><span class="label">${escapeHtml(a.label || '')}</span></div>`,
          ),
        );
        if (live && a.detail) msgs.appendChild(el(`<div class="activity-detail">${escapeHtml(a.detail)}</div>`));
      });
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
      msgs.appendChild(el(`<div class="bubble ${m.role}">${escapeHtml(m.text)}</div>`));
    }
    flushActs();
  }
  app.appendChild(msgs);
  scrollChat(msgs);

  if (state.upgrade) {
    const upgrade = el(`<div class="upgrade-pop">
      <h1>${state.quota && state.quota.isPaid ? 'Your included usage is used up' : 'Upgrade to run OLKIL cloud models'}</h1>
      <p>${
        state.quota && state.quota.isPaid
          ? 'Buy Lite, Pro, or Ultra again — same wallet as the OLKIL desktop app.'
          : 'Free includes chat. Cloud agent needs Lite, Pro, or Ultra — or pick Custom at the top and use your own API.'
      }</p>
      <div class="plans"></div>
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

  const composer = el(`<div class="composer">
    <div class="input-surface">
      <textarea id="input" rows="1" placeholder="Ask Agent…"></textarea>
      <div class="input-footer">
        <span class="composer-hint"><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span>
        <button class="send-btn${state.busy ? ' send-btn-stop' : ''}" id="send" type="button" title="${
          state.busy ? 'Stop' : 'Send'
        }" aria-label="${state.busy ? 'Stop' : 'Send'}">
          ${
            state.busy
              ? '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          }
        </button>
      </div>
    </div>
  </div>`);
  app.appendChild(composer);
  const input = composer.querySelector('#input');
  input.value = draft || '';
  state.draft = input.value;
  input.addEventListener('input', () => {
    state.draft = input.value;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 168) + 'px';
  });
  const send = () => {
    if (state.busy) {
      vscode.postMessage({ type: 'abort' });
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    state.draft = '';
    vscode.postMessage({ type: 'send', text });
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
  const wrap = el(`<div class="file-card">
    <div class="file-head">
      <span class="file-head-title">Edited ${n} file${n === 1 ? '' : 's'}</span>
      <span class="file-stats"><span class="add">+${add}</span><span class="del">−${del}</span></span>
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
    const row = el(`<button class="file-row" type="button">
      <span class="file-name">${escapeHtml(f.name || f.path)}</span>
      <span class="file-stats"><span class="add">+${addN}</span><span class="del">−${delN}</span></span>
    </button>`);
    row.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: f.path }));
    list.appendChild(row);
  }
  return wrap;
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
  } else if (msg.type === 'status' || msg.type === 'activity') {
    if (state.upgrade) return;
    state.busy = true;
    const label = msg.label || msg.text || '';
    if (!label || /opening olkil|engine ready|preparing the coding engine/i.test(label)) return;
    upsertMessage({
      role: 'activity',
      id: msg.id || 'working',
      label,
      detail: msg.detail || '',
      done: !!msg.done,
    });
    render({ keepFocus: true });
  } else if (msg.type === 'files') {
    upsertMessage({ role: 'files', files: Array.isArray(msg.files) ? msg.files : [] });
    render({ keepFocus: true });
  } else if (msg.type === 'user') {
    state.messages.push({ role: 'user', text: msg.text });
    render();
  } else if (msg.type === 'assistant') {
    state.busy = true;
    const last = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.live);
    if (last) {
      last.text = msg.text;
      last.live = !!msg.live;
    } else {
      state.messages.push({ role: 'assistant', text: msg.text, live: !!msg.live });
    }
    render({ keepFocus: true });
  } else if (msg.type === 'error') {
    state.busy = false;
    state.messages.push({ role: 'error', text: msg.text });
    render({ keepFocus: true });
  } else if (msg.type === 'idle') {
    state.busy = false;
    for (const m of state.messages) {
      if (m.role === 'activity') {
        m.done = true;
        if (/^(Working|Thought|Writing)/i.test(m.label || '')) m.hide = true;
      }
      if (m.role === 'assistant') m.live = false;
    }
    state.messages = state.messages.filter((m) => !m.hide);
    render({ keepFocus: true });
  } else if (msg.type === 'upgrade') {
    state.upgrade = true;
    state.busy = false;
    state.messages = state.messages.filter((m) => m.role !== 'activity');
    render();
  } else if (msg.type === 'reset') {
    state.busy = false;
    state.messages = [];
    render();
  }
});

render();
vscode.postMessage({ type: 'ready' });
