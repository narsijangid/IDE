/* WebRTC peer for the editor window. Frames are drawn here and sent to the phone. */
(function () {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  let pc = null;
  let channel = null;
  let canvas = null;
  let ctx = null;
  let session = '';
  let ice = [];
  let appliedAnswer = '';
  let appliedIce = 0;
  let pending = [];
  let publishTimer = 0;

  function api() {
    return window.olkilVs || null;
  }

  function post(msg) {
    const vscode = api();
    if (vscode) vscode.postMessage(msg);
  }

  function reset() {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = 0;
    if (channel) channel.close();
    channel = null;
    if (pc) pc.close();
    pc = null;
    session = '';
    ice = [];
    appliedAnswer = '';
    appliedIce = 0;
    pending = [];
  }

  function publish() {
    if (!pc || !pc.localDescription) return;
    post({
      type: 'screenOffer',
      session: session,
      offer: pc.localDescription.sdp || '',
      ice: ice.join('\n'),
    });
  }

  function schedule() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = 0;
      publish();
    }, 200);
  }

  async function start(nextSession) {
    reset();
    session = nextSession || '';
    canvas = canvas || document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(24);
    pc = new RTCPeerConnection({ iceServers: ICE });
    stream.getTracks().forEach((track) => {
      if ('contentHint' in track) track.contentHint = 'detail';
      const sender = pc.addTrack(track, stream);
      try {
        const params = sender.getParameters();
        params.degradationPreference = 'maintain-resolution';
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = 4000000;
        sender.setParameters(params).catch(() => undefined);
      } catch (err) {
        /* older webviews keep the default sender */
      }
    });
    channel = pc.createDataChannel('input');
    channel.onmessage = (event) => post({ type: 'screenInput', raw: String(event.data || '') });
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      ice.push(JSON.stringify(event.candidate.toJSON()));
      schedule();
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    schedule();
  }

  async function applySignal(msg) {
    if (!pc || String(msg.session || '') !== session) return;
    const answer = String(msg.answer || '');
    if (answer && answer !== appliedAnswer && pc.signalingState !== 'stable') {
      appliedAnswer = answer;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        const queued = pending.splice(0);
        for (const candidate of queued) {
          await pc.addIceCandidate(candidate).catch(() => undefined);
        }
      } catch (err) {
        appliedAnswer = '';
      }
    }
    const lines = String(msg.ice || '').split('\n').filter(Boolean);
    while (appliedIce < lines.length) {
      const raw = lines[appliedIce++];
      let candidate = null;
      try {
        candidate = JSON.parse(raw);
      } catch (err) {
        continue;
      }
      if (!pc.remoteDescription) {
        pending.push(candidate);
        continue;
      }
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  function draw(jpeg) {
    if (!ctx || !canvas || !jpeg) return;
    const image = new Image();
    image.onload = () => {
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      ctx.drawImage(image, 0, 0);
    };
    image.src = 'data:image/jpeg;base64,' + jpeg;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'screenStart') void start(String(msg.session || ''));
    else if (msg.type === 'screenSignal') void applySignal(msg);
    else if (msg.type === 'screenFrame') draw(String(msg.jpeg || ''));
    else if (msg.type === 'screenStop') reset();
  });
})();
