import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import ScreenStage from './Screen';
import {
  MODELS,
  clearLink,
  isOnline,
  readLink,
  removeTask,
  requestStop,
  saveLink,
  saveTask,
  secretFrom,
  sendCommand,
  uploadImage,
  watchDevice,
  watchTasks,
} from './firebase';

const IDEAS = [
  { icon: 'bug', title: 'Fix the open bug', detail: 'Look at the file I have open and fix it.', text: 'Look at the file I have open and fix the bug.' },
  { icon: 'doc', title: 'Explain this project', detail: 'How the code is put together.', text: 'Explain how this project is structured.' },
  { icon: 'spark', title: 'Add a small feature', detail: 'Tell the PC what to build.', text: 'Add a small feature: ' },
];

export default function App() {
  const [link, setLink] = useState(() => readLink());
  const connect = useCallback((secret) => {
    const saved = saveLink(secret);
    if (saved) setLink(saved);
  }, []);
  if (!link) return <Scan onLink={connect} />;
  return (
    <Chat
      link={link}
      onDisconnect={() => {
        clearLink();
        setLink('');
      }}
    />
  );
}

function Scan({ onLink }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let dead = false;
    let stream = null;
    let raf = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function run() {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!dead) setError('This phone cannot open the camera from the page.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        if (!dead) setError('Allow camera access so you can scan the code.');
        return;
      }
      const video = videoRef.current;
      if (!video || dead) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay can wait for a tap */
      }
      const tick = () => {
        if (dead) return;
        if (video.readyState >= 2 && ctx) {
          const w = video.videoWidth || 0;
          const h = video.videoHeight || 0;
          if (w && h) {
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const image = ctx.getImageData(0, 0, w, h);
            const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
            const secret = secretFrom(code?.data || '');
            if (secret) {
              dead = true;
              stream.getTracks().forEach((track) => track.stop());
              onLink(secret);
              return;
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    void run();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [onLink, retry]);

  return (
    <div className="app center">
      <div className="gate scan">
        <img className="brand-icon" src={`${import.meta.env.BASE_URL}favicon.png`} alt="" />
        <h1>Scan to connect</h1>
        <p>On your computer, turn on Remote Access and scan that QR code.</p>
        <div className="viewfinder">
          <video ref={videoRef} playsInline muted autoPlay />
        </div>
        {error ? (
          <>
            <p className="err">{error}</p>
            <button
              className="go"
              onClick={() => {
                setError('');
                setRetry((n) => n + 1);
              }}
            >
              Try camera again
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Chat({ link, onDisconnect }) {
  const [device, setDevice] = useState(null);
  const [messages, setMessages] = useState([]);
  const [live, setLive] = useState(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('agent');
  const [modelId, setModelId] = useState('auto');
  const [images, setImages] = useState([]);
  const [sheet, setSheet] = useState('');
  const [customForm, setCustomForm] = useState({ model: '', baseUrl: '', apiKey: '' });
  const [savingCustom, setSavingCustom] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [screenOpen, setScreenOpen] = useState(() => location.hash === '#screen');
  const threadRef = useRef(null);
  const doneRef = useRef(new Set());
  const stopRef = useRef('');
  const abortSend = useRef(false);
  const boxRef = useRef(null);

  useEffect(() => {
    return watchDevice(link, (row, err) => {
      setDevice(row);
      if (err) setError(permissionText(err));
    });
  }, [link]);

  useEffect(() => {
    return watchTasks(link, (rows, err) => {
      if (err) setError(permissionText(err));
      const row = [...rows].sort((a, b) => timeOf(b) - timeOf(a))[0];
      if (!row) {
        if (stopRef.current && !doneRef.current.has(stopRef.current)) {
          const id = stopRef.current;
          doneRef.current.add(id);
          stopRef.current = '';
          setMessages((prev) => [...prev, { id: id + '-stop', role: 'assistant', text: 'Stopped.' }]);
        }
        setLive(null);
        return;
      }
      if (row.cancelRequested && row.status !== 'done' && row.status !== 'error') {
        stopRef.current = row.id;
        setLive(row);
        return;
      }
      if (row.status === 'upgrade') {
        if (!doneRef.current.has(row.id)) {
          doneRef.current.add(row.id);
          setUpgradeOpen(true);
          void removeTask(link, row.id, row.imagePaths);
        }
        setLive(null);
        return;
      }
      if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
        if (!doneRef.current.has(row.id)) {
          doneRef.current.add(row.id);
          if (row.status !== 'cancelled') {
            setMessages((prev) => [
              ...prev,
              {
                id: row.id + '-a',
                role: 'assistant',
                text: row.reply || (row.status === 'error' ? row.error || 'Something went wrong on the PC.' : 'Done.'),
                files: Array.isArray(row.files) ? row.files : [],
                review: Array.isArray(row.files) && row.files.length ? 'pending' : '',
                bad: row.status === 'error',
              },
            ]);
          }
          void removeTask(link, row.id, row.imagePaths);
        }
        setLive(null);
        return;
      }
      setLive(row);
    });
  }, [link]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, live, text]);

  useEffect(() => {
    const sync = () => setScreenOpen(location.hash === '#screen');
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', screenOpen ? '#050506' : '#F3F4F6');
  }, [screenOpen]);

  function openScreen() {
    if (location.hash !== '#screen') history.pushState({ view: 'screen' }, '', '#screen');
    setScreenOpen(true);
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    const entered = request ? request.call(root) : Promise.resolve();
    Promise.resolve(entered)
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => undefined);
  }

  function closeScreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (document.fullscreenElement && exit) exit.call(document).catch(() => undefined);
    if (history.state?.view === 'screen') {
      history.back();
      return;
    }
    if (location.hash === '#screen') history.replaceState(null, '', location.pathname + location.search);
    setScreenOpen(false);
  }

  const online = isOnline(device);
  const models = Array.isArray(device?.models) && device.models.length ? device.models : MODELS;
  const model = models.find((m) => m.id === modelId) || models[0];
  const running = !!(live && (live.status === 'queued' || live.status === 'running' || live.cancelRequested));
  const busy = sending || running;
  const canSend = !busy && online && (text.trim() || images.length > 0);

  useEffect(() => {
    if (model && !models.some((m) => m.id === modelId)) setModelId(model.id);
  }, [model, modelId, models]);

  function grow(el) {
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 96) + 'px';
  }

  async function send(bodyText) {
    const body = String(bodyText ?? text).trim();
    if (busy || !online || !device || (!body && images.length === 0)) return;
    const files = images.slice();
    const previews = files.map((file) => URL.createObjectURL(file));
    const taskId = 't' + Date.now().toString(36);
    abortSend.current = false;
    setMessages((prev) => [...prev, { id: taskId, role: 'user', text: body, images: previews }]);
    setText('');
    setImages([]);
    if (boxRef.current) boxRef.current.style.height = '24px';
    setSending(true);
    setError('');
    try {
      const imageUrls = [];
      const imagePaths = [];
      for (const file of files) {
        const uploaded = await uploadImage(link, taskId, file);
        imageUrls.push(uploaded.url);
        imagePaths.push(uploaded.path);
      }
      if (abortSend.current) return;
      const now = new Date().toISOString();
      await saveTask(link, taskId, {
        taskId,
        deviceId: device.id,
        text: body,
        modelId: model?.id || 'auto',
        mode,
        status: 'queued',
        phase: 'Planning next moves',
        reply: '',
        error: '',
        steps: [],
        files: [],
        imageUrls,
        imagePaths,
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
        source: 'pocket',
      });
    } catch (err) {
      if (!abortSend.current) {
        setError(permissionText(err));
        setMessages((prev) => prev.filter((m) => m.id !== taskId));
      }
    } finally {
      setSending(false);
      if (abortSend.current) {
        try {
          await removeTask(link, taskId, []);
        } catch {
          /* not saved */
        }
      }
    }
  }

  async function stop() {
    if (sending && !live) {
      abortSend.current = true;
      setSending(false);
      setMessages((prev) => [...prev, { id: 'stop-' + Date.now(), role: 'assistant', text: 'Stopped.' }]);
      return;
    }
    if (!live?.id) return;
    stopRef.current = live.id;
    setError('');
    try {
      if (live.status === 'queued' && !live.cancelRequested) {
        await removeTask(link, live.id, live.imagePaths);
      } else {
        await requestStop(link, live.id);
      }
    } catch (err) {
      setError(permissionText(err));
    }
  }

  async function review(messageId, kind) {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, review: kind } : m)));
    try {
      await sendCommand(link, { kind });
    } catch (err) {
      setError(permissionText(err));
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, review: 'pending' } : m)));
    }
  }

  async function saveCustomModel() {
    const model = customForm.model.trim();
    const baseUrl = customForm.baseUrl.trim();
    const apiKey = customForm.apiKey.trim();
    if (!model || !baseUrl || !apiKey) {
      setError('Add model id, base URL, and API key.');
      return;
    }
    setSavingCustom(true);
    setError('');
    try {
      await sendCommand(link, { kind: 'custom', model, baseUrl, apiKey });
      setCustomForm({ model: '', baseUrl: '', apiKey: '' });
      setSheet('');
    } catch (err) {
      setError(permissionText(err));
    }
    setSavingCustom(false);
  }

  const showHome = messages.length === 0 && !live;

  return (
    <div className="app chat">
      <header className="head">
        <img className="brand-icon" src={`${import.meta.env.BASE_URL}favicon.png`} alt="" />
        <div className="greet">{device?.name || 'OLKIL Remote'}</div>
        <button
          className={online ? 'status on' : 'status'}
          onClick={() => setSheet('account')}
        >
          <span className="pulse" />
          {online ? 'Online' : 'Offline'}
        </button>
      </header>

      <button className="view-screen" onClick={openScreen}>
        <span className="view-ico" aria-hidden="true" />
        View Screen
      </button>

      <div className="thread" ref={threadRef}>
        {showHome ? (
          <div className="home">
            <h1>What should your PC do?</h1>
            <p>Describe the task. Your computer does the work, and you see it here while it runs.</p>
            {!online ? <p className="warn">Turn on Remote Access in OLKIL on your computer.</p> : null}
            <div className="sec">
              <span>Suggested</span>
            </div>
            {IDEAS.map((idea) => (
              <button key={idea.title} className="card" onClick={() => setText(idea.text)}>
                <span className="ico">{idea.icon === 'bug' ? <Bug /> : idea.icon === 'doc' ? <Doc /> : <Spark />}</span>
                <span>
                  <strong>{idea.title}</strong>
                  <em>{idea.detail}</em>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} onReview={review} />
            ))}
            {live ? <Live task={live} /> : null}
          </>
        )}
        {error ? <p className="warn">{error}</p> : null}
      </div>

      {images.length ? (
        <div className="thumbs">
          {images.map((file, i) => (
            <button key={file.name + i} className="thumb" onClick={() => setImages(images.filter((_, n) => n !== i))}>
              <img alt="" src={URL.createObjectURL(file)} />
            </button>
          ))}
        </div>
      ) : null}

      <div className="dock">
        <div className="composer">
          <textarea
            ref={boxRef}
            rows={1}
            placeholder="Describe the task…"
            value={text}
            maxLength={8000}
            disabled={busy}
            onChange={(e) => {
              setText(e.target.value);
              grow(e.target);
            }}
          />
          <div className="bar">
            <label className="round dark" aria-label="Image">
              +
              <input
                hidden
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file && images.length < 4) setImages([...images, file]);
                }}
              />
            </label>
            <button className="pill" onClick={() => setSheet('models')}>
              {mode === 'ask' ? 'Ask' : 'Agent'} · {model?.label || 'Auto'}
            </button>
            <button className="mini" onClick={() => setMode(mode === 'agent' ? 'ask' : 'agent')}>
              {mode === 'agent' ? 'Ask' : 'Agent'}
            </button>
            {busy ? (
              <button className="round dark stop" onClick={stop} aria-label="Stop">
                <i />
              </button>
            ) : (
              <button className="round dark send" disabled={!canSend} onClick={() => send()} aria-label="Send">
                ↑
              </button>
            )}
          </div>
        </div>
      </div>

      {screenOpen ? <ScreenStage secret={link} online={online} onClose={closeScreen} /> : null}

      {upgradeOpen ? <Upgrade onClose={() => setUpgradeOpen(false)} /> : null}

      {sheet ? (
        <div className="sheet" onClick={() => setSheet('')}>
          <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
            {sheet === 'models' ? (
              <>
                <button className="custom-entry" onClick={() => setSheet('custom')}>
                  <span>Custom model</span>
                </button>
                {models.map((m) => (
                  <button
                    key={m.id}
                    className={m.id === model?.id ? 'row on' : 'row'}
                    onClick={() => {
                      setModelId(m.id);
                      setSheet('');
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </>
            ) : null}
            {sheet === 'custom' ? (
              <div className="custom-form">
                <p className="account">Custom model</p>
                <input
                  placeholder="Model ID"
                  value={customForm.model}
                  autoComplete="off"
                  onChange={(e) => setCustomForm({ ...customForm, model: e.target.value })}
                />
                <input
                  placeholder="Base URL"
                  value={customForm.baseUrl}
                  autoComplete="off"
                  onChange={(e) => setCustomForm({ ...customForm, baseUrl: e.target.value })}
                />
                <input
                  placeholder="API key"
                  type="password"
                  value={customForm.apiKey}
                  autoComplete="off"
                  onChange={(e) => setCustomForm({ ...customForm, apiKey: e.target.value })}
                />
                <button className="go" disabled={savingCustom} onClick={saveCustomModel}>
                  {savingCustom ? 'Saving…' : 'Save on PC'}
                </button>
              </div>
            ) : null}
            {sheet === 'account' ? (
              <>
                <p className="account">{device?.name || 'This computer'}</p>
                <p className="account">{online ? 'PC online' : 'PC offline'}{device?.workspace ? ` · ${device.workspace}` : ''}</p>
                <button className="row" onClick={onDisconnect}>
                  Disconnect
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Upgrade({ onClose }) {
  const plans = [
    { id: 'free', name: 'Free', price: 'Free', period: '', blurb: '30,000 tokens · Bring your own API key' },
    { id: 'lite', name: 'Lite', price: '$10', period: '/ mo', blurb: 'Cloud agent and frontier models' },
    { id: 'pro', name: 'Pro', price: '$20', period: '/ mo', blurb: 'Extended limits on Agent', featured: true },
    { id: 'ultra', name: 'Ultra', price: '$100', period: '/ mo', blurb: 'Parallel agents and priority' },
  ];
  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet-card upgrade" onClick={(e) => e.stopPropagation()}>
        <h2>Upgrade to run OLKIL cloud models</h2>
        <p>Free includes chat. Cloud agent needs Lite, Pro, or Ultra — or add a Custom model and use your own API.</p>
        {plans.map((plan) =>
          plan.id === 'free' ? (
            <div key={plan.id} className="plan">
              <strong>{plan.name}</strong>
              <b>
                {plan.price}
                <small>{plan.period}</small>
              </b>
              <em>{plan.blurb}</em>
              <span>Included</span>
            </div>
          ) : (
            <a key={plan.id} className={plan.featured ? 'plan featured' : 'plan'} href={`https://olkil.com/checkout/?plan=${plan.id}`}>
              <strong>{plan.name}</strong>
              <b>
                {plan.price}
                <small>{plan.period}</small>
              </b>
              <em>{plan.blurb}</em>
              <span>{plan.featured ? 'Get Pro' : 'Upgrade'}</span>
            </a>
          ),
        )}
        <button className="row" onClick={onClose}>
          Keep chatting
        </button>
      </div>
    </div>
  );
}

function Bubble({ msg, onReview }) {
  return (
    <div className={'bubble ' + (msg.role === 'user' ? 'out' : 'in') + (msg.bad ? ' bad' : '')}>
      {msg.images?.length ? (
        <div className="shots">
          {msg.images.map((src) => (
            <img key={src} alt="" src={src} />
          ))}
        </div>
      ) : null}
      {msg.text ? <p>{msg.text}</p> : null}
      {(msg.files || []).map((file) => (
        <Diff key={file.path} file={file} />
      ))}
      {msg.review === 'pending' ? (
        <div className="review">
          <button className="rev" onClick={() => onReview(msg.id, 'accept')}>
            Accept
          </button>
          <button className="rev ghost" onClick={() => onReview(msg.id, 'revert')}>
            Revert
          </button>
        </div>
      ) : null}
      {msg.review === 'accept' ? <div className="noted">Accepted on your PC</div> : null}
      {msg.review === 'revert' ? <div className="noted">Reverted on your PC</div> : null}
    </div>
  );
}

function Live({ task }) {
  const steps = Array.isArray(task.steps) ? task.steps.slice(-3) : [];
  const files = Array.isArray(task.files) ? task.files : [];
  return (
    <div className="bubble in live">
      {task.cancelRequested ? <div className="phase">Stopping…</div> : null}
      {task.reply ? <p>{task.reply}</p> : <div className="typing"><i /><i /><i /></div>}
      {!task.cancelRequested && task.phase ? <div className="phase">{task.phase}</div> : null}
      {steps.map((s, i) => (
        <div key={s.id || i} className="step">
          {s.label}
        </div>
      ))}
      {files.map((file) => (
        <Diff key={file.path} file={file} />
      ))}
    </div>
  );
}

function Diff({ file }) {
  const name = String(file.path || 'file').split(/[/\\]/).pop();
  const lines = Array.isArray(file.preview) ? file.preview : [];
  return (
    <div className="diff">
      <div className="diff-h">
        <span>{name}</span>
        <b className="add">+{file.additions || 0}</b>
        <b className="del">−{file.deletions || 0}</b>
      </div>
      {lines.length ? (
        <pre>
          {lines.map((line, i) => (
            <div key={i} className={'ln ' + (line.type || '')}>
              {line.text || ' '}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function timeOf(task) {
  const n = Date.parse(task.updatedAt || task.createdAt || '');
  return Number.isFinite(n) ? n : 0;
}

function permissionText(err) {
  const msg = String(err?.message || err || '');
  if (/permission|insufficient/i.test(msg)) return 'Firebase blocked this. Deploy Remote rules on olkil-2c8ac.';
  return msg || 'Something went wrong';
}

function Clock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v4.5l2.5 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function Bug() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 9a4 4 0 0 1 8 0v2a4 4 0 0 1-8 0V9Z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 10h2M17 10h2M5 14h2M17 14h2M12 7V5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function Doc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4h7l4 4v12H7V4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M14 4v4h4M9 13h6M9 16h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function Spark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}
