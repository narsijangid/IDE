/**
 * Shares this IDE window to olkil.com/pocket while Remote Access is on.
 * The phone gets a live picture and can click and type inside the window.
 * Firestore only carries the WebRTC handshake. The picture never goes through Firebase.
 */

const API = 'https://firestore.googleapis.com/v1/projects/olkil-2c8ac/databases/(default)/documents';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

type ElectronIpc = {
  invoke(channel: string): Promise<string>;
  send(channel: string, payload?: unknown): void;
};

export class IdeScreenShare {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private session = '';
  private offer = '';
  private ice: string[] = [];
  private appliedAnswer = '';
  private appliedIce = 0;
  private pendingIce: RTCIceCandidateInit[] = [];
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private on = false;
  private restartAt = 0;
  private seenAgain = '';

  constructor(
    private secret: () => string,
    private token: () => Promise<string | null>,
  ) {}

  async start(): Promise<void> {
    if (this.on) return;
    const secret = this.secret();
    if (!secret) return;
    this.on = true;
    this.session = randomId();
    this.offer = '';
    this.ice = [];
    this.appliedAnswer = '';
    this.appliedIce = 0;
    this.pendingIce = [];
    ipc().send('olkil:screen-arm', true);
    try {
      await this.openPeer();
    } catch {
      this.on = false;
      ipc().send('olkil:screen-arm', false);
      return;
    }
    this.timer = setInterval(() => void this.pollViewer(), 500);
  }

  async stop(): Promise<void> {
    this.on = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.closePeer();
    ipc().send('olkil:screen-arm', false);
    const idToken = await this.token();
    const secret = this.secret();
    if (!idToken || !secret) return;
    await fetch(docUrl(secret, 'box/screenHost'), { method: 'DELETE', headers: auth(idToken) }).catch(() => undefined);
    await fetch(docUrl(secret, 'box/screenViewer'), { method: 'DELETE', headers: auth(idToken) }).catch(() => undefined);
  }

  private async openPeer(): Promise<void> {
    const sourceId = await ipc().invoke('olkil:screen-source');
    if (!sourceId) throw new Error('no window');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 24,
          maxWidth: 1920,
          maxHeight: 1080,
        },
      },
    } as MediaStreamConstraints);
    this.stream = stream;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const channel = pc.createDataChannel('input');
    this.channel = channel;
    channel.onmessage = (event) => {
      try {
        ipc().send('olkil:screen-input', JSON.parse(String(event.data || '')));
      } catch {
        /* ignore a bad control packet */
      }
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.ice.push(JSON.stringify(event.candidate.toJSON()));
      this.schedulePublish();
    };
    pc.onconnectionstatechange = () => {
      if (!this.on) return;
      const state = pc.connectionState;
      if (state === 'failed' && Date.now() - this.restartAt > 4000) {
        this.restartAt = Date.now();
        void this.restart();
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.offer = offer.sdp || '';
    this.schedulePublish();
    const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
    if (sender) {
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] || {}), maxBitrate: 2_500_000, maxFramerate: 24 }];
      void sender.setParameters(params).catch(() => undefined);
    }
  }

  private async restart(): Promise<void> {
    if (!this.on) return;
    this.closePeer();
    this.session = randomId();
    this.offer = '';
    this.ice = [];
    this.appliedAnswer = '';
    this.appliedIce = 0;
    this.pendingIce = [];
    try {
      await this.openPeer();
    } catch {
      /* the next poll interval will not reconnect until start() again */
    }
  }

  private closePeer(): void {
    this.channel?.close();
    this.channel = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.pc?.close();
    this.pc = null;
  }

  private schedulePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publish();
    }, 200);
  }

  private async publish(): Promise<void> {
    if (!this.on || !this.offer) return;
    const idToken = await this.token();
    const secret = this.secret();
    if (!idToken || !secret) return;
    await patch(secret, 'box/screenHost', idToken, {
      session: this.session,
      offer: this.offer,
      ice: this.ice.join('\n'),
      at: new Date().toISOString(),
    });
  }

  private async pollViewer(): Promise<void> {
    if (!this.on || !this.pc) return;
    const idToken = await this.token();
    const secret = this.secret();
    if (!idToken || !secret) return;
    const data = await readDoc(secret, 'box/screenViewer', idToken);
    if (!data) return;
    const again = String(data.again || '');
    if (again && again !== this.seenAgain && (this.pc.connectionState === 'connected' || this.pc.connectionState === 'failed')) {
      this.seenAgain = again;
      void this.restart();
      return;
    }
    if (String(data.session || '') !== this.session) return;
    const answer = String(data.answer || '');
    if (answer && answer !== this.appliedAnswer && this.pc.signalingState !== 'stable') {
      this.appliedAnswer = answer;
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: answer });
        const queued = this.pendingIce.splice(0);
        for (const candidate of queued) {
          await this.pc.addIceCandidate(candidate).catch(() => undefined);
        }
      } catch {
        this.appliedAnswer = '';
      }
    }
    const lines = String(data.ice || '').split('\n').filter(Boolean);
    while (this.appliedIce < lines.length) {
      const raw = lines[this.appliedIce++];
      let candidate: RTCIceCandidateInit | null = null;
      try {
        candidate = JSON.parse(raw) as RTCIceCandidateInit;
      } catch {
        continue;
      }
      if (!this.pc.remoteDescription) {
        this.pendingIce.push(candidate);
        continue;
      }
      await this.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}

function ipc(): ElectronIpc {
  return require('electron').ipcRenderer as ElectronIpc;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function docUrl(secret: string, rel: string): string {
  return API + '/links/' + secret + '/' + rel;
}

function auth(idToken: string): Record<string, string> {
  return { Authorization: 'Bearer ' + idToken };
}

async function readDoc(secret: string, rel: string, idToken: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(docUrl(secret, rel), { headers: auth(idToken) });
  if (!res.ok) return null;
  const json = (await res.json()) as { fields?: Record<string, unknown> };
  return decodeFields(json.fields || {});
}

async function patch(secret: string, rel: string, idToken: string, data: Record<string, unknown>): Promise<void> {
  const mask = Object.keys(data)
    .map((field) => 'updateMask.fieldPaths=' + encodeURIComponent(field))
    .join('&');
  await fetch(docUrl(secret, rel) + '?' + mask, {
    method: 'PATCH',
    headers: { ...auth(idToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
}

function encodeFields(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) fields[key] = { stringValue: value == null ? '' : String(value) };
  return fields;
}

function decodeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const row = value as { stringValue?: string };
    out[key] = row && typeof row === 'object' && 'stringValue' in row ? row.stringValue : '';
  }
  return out;
}
