import { initializeApp } from 'firebase/app';
import { collection, deleteDoc, doc, getFirestore, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';

const firebaseConfig = {
  apiKey: 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k',
  authDomain: 'olkil-2c8ac.firebaseapp.com',
  projectId: 'olkil-2c8ac',
  storageBucket: 'olkil-2c8ac.firebasestorage.app',
  messagingSenderId: '781364120676',
  appId: '1:781364120676:web:b95ff8f1839b3a0b0aa371',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

const LINK_KEY = 'olkil.link';

export const MODELS = [
  { id: 'auto', label: 'Auto' },
  { id: 'x-ai/grok-4.6', label: 'Grok 4.6' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

export function secretFrom(raw) {
  const text = String(raw || '').trim();
  const found = text.match(/(?:^|[?#&])k=([a-f0-9]{64})(?:$|&)/i);
  if (found) return found[1].toLowerCase();
  if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  return '';
}

export function readLink() {
  const fromUrl = secretFrom(location.hash) || secretFrom(location.search);
  if (fromUrl) {
    localStorage.setItem(LINK_KEY, fromUrl);
    const clean = location.pathname + location.search.replace(/([?&])k=[a-f0-9]{64}&?/i, '$1').replace(/[?&]$/, '');
    history.replaceState(null, '', clean);
  }
  const saved = localStorage.getItem(LINK_KEY) || '';
  return /^[a-f0-9]{64}$/.test(saved) ? saved : '';
}

export function saveLink(secret) {
  const next = secretFrom(secret);
  if (!next) return '';
  localStorage.setItem(LINK_KEY, next);
  return next;
}

export function clearLink() {
  localStorage.removeItem(LINK_KEY);
}

export function watchDevice(secret, cb) {
  return onSnapshot(
    doc(db, 'links', secret),
    (snap) => {
      if (!snap.exists()) {
        cb(null, null);
        return;
      }
      const data = snap.data() || {};
      cb({ id: data.deviceId || snap.id, ...data }, null);
    },
    (err) => cb(null, err),
  );
}

export function watchBox(secret, id, cb) {
  return onSnapshot(
    doc(db, 'links', secret, 'box', id),
    (snap) => cb(snap.exists() ? snap.data() || {} : null),
    () => cb(null),
  );
}

export async function writeBox(secret, id, data) {
  await setDoc(doc(db, 'links', secret, 'box', id), data);
}

export function watchTasks(secret, cb) {
  return onSnapshot(
    collection(db, 'links', secret, 'tasks'),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => cb([], err),
  );
}

export function isOnline(device) {
  if (!device) return false;
  const flag = device.online;
  if (flag === false || flag === 'false') return false;
  const seen = seenAt(device.lastSeen);
  if (!Number.isFinite(seen)) return flag === true || flag === 'true';
  return Date.now() - seen < 120000;
}

function seenAt(value) {
  if (!value) return NaN;
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  return Date.parse(String(value));
}

export async function saveTask(secret, taskId, data) {
  await setDoc(doc(db, 'links', secret, 'tasks', taskId), data);
}

export async function requestStop(secret, taskId) {
  await updateDoc(doc(db, 'links', secret, 'tasks', taskId), {
    cancelRequested: true,
    updatedAt: new Date().toISOString(),
  });
}

export async function sendCommand(secret, data) {
  await setDoc(doc(db, 'links', secret, 'box', 'command'), {
    ...data,
    at: new Date().toISOString(),
  });
}

export async function uploadImage(secret, taskId, file) {
  const safe = (file.name || 'image.jpg').replace(/[^\w.-]/g, '') || 'image.jpg';
  const path = `links/${secret}/tasks/${taskId}/${Date.now()}-${safe}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type || 'image/jpeg' });
  const url = await getDownloadURL(fileRef);
  return { url, path };
}

export async function removeTask(secret, taskId, paths) {
  for (const path of paths || []) {
    if (!path) continue;
    try {
      await deleteObject(ref(storage, path));
    } catch {
      /* already gone */
    }
  }
  try {
    await deleteDoc(doc(db, 'links', secret, 'tasks', taskId));
  } catch {
    /* already gone */
  }
}
