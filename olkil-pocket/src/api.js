import AsyncStorage from '@react-native-async-storage/async-storage';

const API_KEY = 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k';
const PROJECT = 'olkil-2c8ac';
const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
const BUCKET = 'olkil-2c8ac.firebasestorage.app';
const KEY = 'olkil.pocket.session';

export const MODELS = [
  { id: 'auto', label: 'Auto' },
  { id: 'x-ai/grok-4.6', label: 'Grok 4.6' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

export async function loadSession() {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSession(session) {
  await AsyncStorage.setItem(KEY, JSON.stringify(session));
}

export async function clearSession() {
  await AsyncStorage.removeItem(KEY);
}

export async function authHeaders(session) {
  const fresh = await ensureToken(session);
  return { Authorization: 'Bearer ' + fresh.idToken, 'Content-Type': 'application/json' };
}

async function ensureToken(session) {
  if (session.expiresAt && Date.now() < session.expiresAt - 60000) return session;
  if (!session.refreshToken) return session;
  const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  });
  const json = await res.json();
  if (!json.id_token) return session;
  const next = {
    ...session,
    idToken: json.id_token,
    refreshToken: json.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
  await saveSession(next);
  Object.assign(session, next);
  return next;
}

function userPath(session, rel) {
  return FS + '/users/' + encodeURIComponent(session.uid) + (rel ? '/' + rel : '');
}

export async function listDocs(session, collection) {
  const headers = await authHeaders(session);
  const res = await fetch(userPath(session, collection), { headers });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await friendly(res));
  const json = await res.json();
  return (json.documents || []).map((doc) => ({
    id: doc.name.split('/').pop(),
    ...decodeFields(doc.fields || {}),
  }));
}

export async function getDoc(session, rel) {
  const headers = await authHeaders(session);
  const res = await fetch(userPath(session, rel), { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await friendly(res));
  const json = await res.json();
  return { id: json.name.split('/').pop(), ...decodeFields(json.fields || {}) };
}

export async function writeDoc(session, rel, data) {
  const headers = await authHeaders(session);
  const paths = Object.keys(data).map((p) => 'updateMask.fieldPaths=' + encodeURIComponent(p)).join('&');
  const res = await fetch(userPath(session, rel) + '?' + paths, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!res.ok) throw new Error(await friendly(res));
}

export function isOnline(device) {
  if (!device || device.online === false) return false;
  const seen = Date.parse(device.lastSeen || '');
  if (!Number.isFinite(seen)) return false;
  return Date.now() - seen < 45000;
}

export async function linkWithCode(session, code) {
  const devices = await listDocs(session, 'devices');
  const now = Date.now();
  const hit = devices.find((d) => String(d.pairCode || '') === String(code).trim() && Date.parse(d.pairExpiresAt || '') > now);
  if (!hit) return null;
  await writeDoc(session, 'devices/' + hit.id, { linked: true, pairCode: '', pairExpiresAt: '' });
  return { ...hit, linked: true };
}

export async function uploadImage(session, taskId, asset) {
  await ensureToken(session);
  const name = (asset.fileName || 'image.jpg').replace(/[^\w.-]/g, '');
  const path = 'users/' + session.uid + '/tasks/' + taskId + '/' + name;
  const fileRes = await fetch(asset.uri);
  const blob = await fileRes.blob();
  const url =
    'https://firebasestorage.googleapis.com/v0/b/' +
    BUCKET +
    '/o?uploadType=media&name=' +
    encodeURIComponent(path);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.idToken, 'Content-Type': asset.mimeType || 'image/jpeg' },
    body: blob,
  });
  if (!res.ok) throw new Error(await friendly(res));
  const json = await res.json();
  const token = json.downloadTokens;
  return (
    'https://firebasestorage.googleapis.com/v0/b/' +
    BUCKET +
    '/o/' +
    encodeURIComponent(path) +
    '?alt=media&token=' +
    token
  );
}

async function friendly(res) {
  const text = await res.text();
  if (/PERMISSION_DENIED|permission/i.test(text)) {
    return 'Firebase blocked this. Deploy Pocket rules on project olkil-2c8ac.';
  }
  return 'Request failed (' + res.status + ')';
}

function encodeFields(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = encodeValue(v);
  return fields;
}

function encodeValue(v) {
  if (v == null || v === '') return { stringValue: v == null ? '' : String(v) };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encodeValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
