import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { watchBox, writeBox } from './firebase';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Live picture of the computer's OLKIL or VS Code window, plus click and typing.
 * The picture arrives over WebRTC. Firebase only carries the handshake.
 */
export default function ScreenStage({ secret, online, onClose }) {
  const videoRef = useRef(null);
  const keyRef = useRef(null);
  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const sessionRef = useRef('');
  const iceRef = useRef([]);
  const hostIceRef = useRef(0);
  const pendingRef = useRef([]);
  const publishRef = useRef(0);
  const againAt = useRef(0);
  const [phase, setPhase] = useState('waiting');
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    let dead = false;

    function closePeer() {
      channelRef.current = null;
      if (pcRef.current) pcRef.current.close();
      pcRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      sessionRef.current = '';
      iceRef.current = [];
      hostIceRef.current = 0;
      pendingRef.current = [];
    }

    function sendInput(payload) {
      const channel = channelRef.current;
      if (!channel || channel.readyState !== 'open') return;
      channel.send(JSON.stringify(payload));
    }

    function schedule() {
      if (publishRef.current) return;
      publishRef.current = window.setTimeout(() => {
        publishRef.current = 0;
        const pc = pcRef.current;
        if (!pc || !pc.localDescription || !sessionRef.current) return;
        void writeBox(secret, 'screenViewer', {
          session: sessionRef.current,
          answer: pc.localDescription.sdp || '',
          ice: iceRef.current.join('\n'),
          again: '',
          at: new Date().toISOString(),
        });
      }, 200);
    }

    async function addHostIce(iceText) {
      const pc = pcRef.current;
      if (!pc) return;
      const lines = String(iceText || '').split('\n').filter(Boolean);
      while (hostIceRef.current < lines.length) {
        const raw = lines[hostIceRef.current++];
        let candidate = null;
        try {
          candidate = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!pc.remoteDescription) {
          pendingRef.current.push(candidate);
          continue;
        }
        await pc.addIceCandidate(candidate).catch(() => undefined);
      }
    }

    async function answer(data) {
      closePeer();
      const session = String(data.session || '');
      const offer = String(data.offer || '');
      if (!session || !offer) {
        setPhase('waiting');
        return;
      }
      sessionRef.current = session;
      setPhase('connecting');
      const pc = new RTCPeerConnection({ iceServers: ICE });
      pcRef.current = pc;
      pc.ontrack = (event) => {
        const video = videoRef.current;
        const stream = event.streams[0];
        if (!video || !stream) return;
        video.srcObject = stream;
        const show = () => {
          if (!dead && video.videoWidth > 0) setPhase('live');
        };
        video.onresize = show;
        video.onloadeddata = show;
        void video.play().then(show).catch(() => undefined);
      };
      pc.ondatachannel = (event) => {
        channelRef.current = event.channel;
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate || sessionRef.current !== session) return;
        iceRef.current.push(JSON.stringify(event.candidate.toJSON()));
        schedule();
      };
      pc.onconnectionstatechange = () => {
        if (dead || pcRef.current !== pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (Date.now() - againAt.current < 5000) return;
          againAt.current = Date.now();
          setPhase('connecting');
          void writeBox(secret, 'screenViewer', {
            session,
            answer: pc.localDescription?.sdp || '',
            ice: iceRef.current.join('\n'),
            again: String(Date.now()),
            at: new Date().toISOString(),
          });
        }
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: offer });
        const queued = pendingRef.current.splice(0);
        for (const candidate of queued) await pc.addIceCandidate(candidate).catch(() => undefined);
        const reply = await pc.createAnswer();
        await pc.setLocalDescription(reply);
        schedule();
        await addHostIce(data.ice);
      } catch {
        if (!dead) setPhase('waiting');
      }
    }

    const stop = watchBox(secret, 'screenHost', (data) => {
      if (dead) return;
      if (!data || !data.offer) {
        closePeer();
        setPhase('waiting');
        return;
      }
      if (data.session === sessionRef.current && pcRef.current) {
        void addHostIce(data.ice);
        return;
      }
      void answer(data);
    });

    const stage = stageRef.current;
    function onPointer(event, kind) {
      if (event.target.closest('button, input')) return;
      const point = pointOnStage(event, stage, boxRef.current);
      if (!point) return;
      if (kind === 'down') event.currentTarget.setPointerCapture?.(event.pointerId);
      sendInput({ t: 'p', k: kind, x: point.x, y: point.y, b: event.button || 0, clicks: event.detail || 1 });
    }
    const el = stage;
    const down = (event) => onPointer(event, 'down');
    const move = (event) => onPointer(event, 'move');
    const up = (event) => {
      onPointer(event, 'up');
      if (event.target.closest('button')) return;
      const input = keyRef.current;
      if (!input) return;
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
    };
    const wheel = (event) => {
      const point = pointOnStage(event, stageRef.current, boxRef.current);
      if (!point) return;
      event.preventDefault();
      sendInput({ t: 'w', x: point.x, y: point.y, dx: event.deltaX, dy: event.deltaY });
    };
    const menu = (event) => event.preventDefault();
    if (el) {
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', wheel, { passive: false });
      el.addEventListener('contextmenu', menu);
    }

    return () => {
      dead = true;
      if (publishRef.current) clearTimeout(publishRef.current);
      stop();
      closePeer();
      if (el) {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('wheel', wheel);
        el.removeEventListener('contextmenu', menu);
      }
    };
  }, [secret]);

  useEffect(() => {
    const stage = stageRef.current;
    const fit = () => {
      if (!stage) return;
      const view = window.visualViewport;
      const fullH = window.innerHeight;
      const visibleH = view?.height || fullH;
      const keyboard = fullH - visibleH > 80;
      if (!keyboard) {
        stage.style.left = '0px';
        stage.style.top = '0px';
        stage.style.width = '100%';
        stage.style.height = '100%';
        return;
      }
      stage.style.left = (view?.offsetLeft || 0) + 'px';
      stage.style.top = (view?.offsetTop || 0) + 'px';
      stage.style.width = (view?.width || window.innerWidth) + 'px';
      stage.style.height = visibleH + 'px';
    };
    fit();
    document.documentElement.style.background = '#000';
    document.body.style.background = '#000';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#000000');
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
      document.body.style.overflow = previous;
    document.documentElement.style.background = '';
    document.body.style.background = '';
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      paintScreen(videoRef.current, canvasRef.current, stageRef.current, boxRef);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  function onKey(event, kind) {
    event.preventDefault();
    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify({
      t: 'key',
      k: kind,
      key: event.key,
      code: event.code,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey,
    }));
  }

  const waiting = !online || phase !== 'live';
  const message = !online
    ? 'Turn on Remote Access in OLKIL, then come back here.'
    : phase === 'connecting'
      ? 'Connecting to the computer…'
      : 'Waiting for the computer screen…';

  return createPortal(
    <div className="viewer" ref={stageRef}>
      <video
        ref={videoRef}
        className="viewer-src"
        playsInline
        muted
        autoPlay
        disablePictureInPicture
      />
      <canvas ref={canvasRef} className="viewer-pic" />
      <button className="viewer-close" onClick={onClose} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
      {waiting ? (
        <div className="viewer-wait">
          <div className="viewer-card">
            <span className="spin light" />
            <strong>{!online ? 'Computer is offline' : phase === 'connecting' ? 'Connecting' : 'Waiting'}</strong>
            <p>{message}</p>
          </div>
        </div>
      ) : null}
      <input
        ref={keyRef}
        className="keytrap"
        aria-label="Type on the computer"
        onKeyDown={(event) => onKey(event, 'down')}
        onKeyUp={(event) => onKey(event, 'up')}
      />
    </div>,
    document.body,
  );
}

function pointOnStage(event, stage, box) {
  if (!stage || !box) return null;
  const rect = stage.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  if (sx < box.left || sy < box.top || sx > box.left + box.dw || sy > box.top + box.dh) return null;
  if (!box.turn) return { x: (sx - box.left) / box.dw, y: (sy - box.top) / box.dh };
  return {
    x: (sy - box.top) / box.dh,
    y: (box.left + box.dw - sx) / box.dw,
  };
}

function paintScreen(video, canvas, stage, boxRef) {
  if (!video || !canvas || !stage) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (!sw || !sh) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(sw * dpr));
  const ph = Math.max(1, Math.round(sh * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, sw, sh);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) {
    boxRef.current = null;
    return;
  }
  const turn = sw < sh;
  if (!turn) {
    const scale = Math.min(sw / vw, sh / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const left = (sw - dw) / 2;
    const top = (sh - dh) / 2;
    ctx.drawImage(video, left, top, dw, dh);
    boxRef.current = { left, top, dw, dh, turn: false };
    return;
  }
  const scale = Math.min(sh / vw, sw / vh);
  const dw = vh * scale;
  const dh = vw * scale;
  const left = (sw - dw) / 2;
  const top = (sh - dh) / 2;
  ctx.setTransform(0, dpr, -dpr, 0, sw * dpr, 0);
  ctx.drawImage(video, top, sw - left - dw, dh, dw);
  boxRef.current = { left, top, dw, dh, turn: true };
}
