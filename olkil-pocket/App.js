import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as WebBrowser from 'expo-web-browser';
import {
  MODELS,
  clearSession,
  getDoc,
  isOnline,
  linkWithCode,
  listDocs,
  loadSession,
  saveSession,
  uploadImage,
  writeDoc,
} from './src/api';

WebBrowser.maybeCompleteAuthSession();

const PINK = '#FF2D8C';
const BG = '#0A0A0B';
const CARD = '#141318';
const TEXT = '#EDEAF5';
const MUTED = '#8A8496';

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState('home');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [tasks, setTasks] = useState([]);
  const [taskId, setTaskId] = useState('');
  const [error, setError] = useState('');
  const [listed, setListed] = useState(false);

  useEffect(() => {
    loadSession().then((s) => {
      setSession(s);
      setReady(true);
      if (!s) setScreen('signin');
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const [devs, all] = await Promise.all([
        listDocs(session, 'devices'),
        listDocs(session, 'tasks'),
      ]);
      const linked = devs.filter((d) => d.linked === true);
      setDevices(linked);
      setDeviceId((cur) => cur || linked[0]?.id || '');
      all.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
      setTasks(all);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not reach OLKIL');
    }
    setListed(true);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    refresh();
    const t = setInterval(refresh, screen === 'run' ? 1500 : 5000);
    return () => clearInterval(t);
  }, [session, refresh, screen]);

  const device = devices.find((d) => d.id === deviceId) || devices[0];
  const task = tasks.find((t) => t.id === taskId);

  if (!ready) {
    return (
      <SafeAreaView style={styles.boot}>
        <ActivityIndicator color={PINK} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {!session ? (
        <SignIn
          onDone={(s) => {
            setSession(s);
            setScreen('link');
          }}
        />
      ) : !listed ? (
        <View style={styles.boot}>
          <ActivityIndicator color={PINK} />
        </View>
      ) : screen === 'link' || devices.length === 0 ? (
        <LinkPC
          session={session}
          onLinked={() => {
            setScreen('home');
            refresh();
          }}
          onSettings={() => setScreen('settings')}
        />
      ) : screen === 'compose' ? (
        <Composer
          session={session}
          device={device}
          onBack={() => setScreen('home')}
          onSent={(id) => {
            setTaskId(id);
            setScreen('run');
            refresh();
          }}
        />
      ) : screen === 'run' && task ? (
        <Run
          session={session}
          task={task}
          device={devices.find((d) => d.id === task.deviceId)}
          onBack={() => setScreen('home')}
        />
      ) : screen === 'history' ? (
        <History
          tasks={tasks}
          onOpen={(id) => {
            setTaskId(id);
            setScreen('run');
          }}
          onBack={() => setScreen('home')}
        />
      ) : screen === 'settings' ? (
        <Settings
          session={session}
          devices={devices}
          onBack={() => setScreen('home')}
          onLink={() => setScreen('link')}
          onSignOut={async () => {
            await clearSession();
            setSession(null);
            setDevices([]);
            setScreen('signin');
          }}
          onUnlink={async (id) => {
            await writeDoc(session, 'devices/' + id, { linked: false });
            if (deviceId === id) setDeviceId('');
            refresh();
          }}
        />
      ) : (
        <Home
          device={device}
          devices={devices}
          tasks={tasks.slice(0, 8)}
          error={error}
          onPick={setDeviceId}
          onNew={() => setScreen('compose')}
          onOpen={(id) => {
            setTaskId(id);
            setScreen('run');
          }}
          onHistory={() => setScreen('history')}
          onSettings={() => setScreen('settings')}
        />
      )}
    </SafeAreaView>
  );
}

function SignIn({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const go = async () => {
    setBusy(true);
    setMsg('');
    try {
      const result = await WebBrowser.openAuthSessionAsync('https://olkil.com/pocket-auth/', 'olkilpocket://auth');
      if (result.type !== 'success') {
        setBusy(false);
        return;
      }
      const url = new URL(result.url);
      const session = {
        idToken: url.searchParams.get('id_token') || '',
        refreshToken: url.searchParams.get('refresh_token') || '',
        uid: url.searchParams.get('uid') || '',
        email: url.searchParams.get('email') || '',
        name: url.searchParams.get('name') || '',
        expiresAt: Date.now() + 55 * 60 * 1000,
      };
      if (!session.idToken || !session.uid) throw new Error('Sign-in did not return an account.');
      await saveSession(session);
      onDone(session);
    } catch (err) {
      setMsg(err.message || 'Sign-in failed');
    }
    setBusy(false);
  };
  return (
    <View style={styles.center}>
      <Text style={styles.brand}>OLKIL</Text>
      <Text style={styles.tag}>Your PC does the work.</Text>
      <Pressable style={styles.primary} onPress={go} disabled={busy}>
        <Text style={styles.primaryText}>{busy ? 'Waiting for Google…' : 'Continue with Google'}</Text>
      </Pressable>
      {msg ? <Text style={styles.err}>{msg}</Text> : null}
    </View>
  );
}

function LinkPC({ session, onLinked, onSettings }) {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setMsg('');
    try {
      const hit = await linkWithCode(session, code);
      if (!hit) setMsg('Code expired or wrong. On the PC, turn Pocket on and try the new code.');
      else onLinked();
    } catch (err) {
      setMsg(err.message);
    }
    setBusy(false);
  };
  return (
    <View style={styles.pad}>
      <Text style={styles.h1}>Link a computer</Text>
      <Text style={styles.sub}>On the PC, run OLKIL: Toggle Pocket and enter the 6-digit code.</Text>
      <TextInput
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        placeholder="000000"
        placeholderTextColor={MUTED}
        style={styles.code}
      />
      <Pressable style={styles.primary} onPress={submit} disabled={busy || code.length < 6}>
        <Text style={styles.primaryText}>{busy ? 'Linking…' : 'Link'}</Text>
      </Pressable>
      {msg ? <Text style={styles.err}>{msg}</Text> : null}
      <Pressable onPress={onSettings} style={styles.textBtn}>
        <Text style={styles.textBtnLabel}>Account</Text>
      </Pressable>
    </View>
  );
}

function Home({ device, devices, tasks, error, onPick, onNew, onOpen, onHistory, onSettings }) {
  const online = isOnline(device);
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <View style={styles.row}>
        <Text style={styles.brandSm}>OLKIL</Text>
        <Pressable onPress={onSettings}>
          <Text style={styles.link}>Settings</Text>
        </Pressable>
      </View>
      {devices.map((d) => (
        <Pressable key={d.id} style={[styles.card, d.id === device?.id && styles.cardOn]} onPress={() => onPick(d.id)}>
          <View style={[styles.dot, isOnline(d) ? styles.dotOn : null]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{d.name || 'PC'}</Text>
            <Text style={styles.cardSub}>{isOnline(d) ? d.workspace || 'Online' : 'Offline'}</Text>
          </View>
        </Pressable>
      ))}
      <Pressable style={[styles.primary, !device && styles.disabled]} onPress={onNew} disabled={!device}>
        <Text style={styles.primaryText}>{online ? 'New task' : 'New task · starts when the PC is on'}</Text>
      </Pressable>
      {error ? <Text style={styles.err}>{error}</Text> : null}
      <View style={styles.row}>
        <Text style={styles.section}>Recent</Text>
        <Pressable onPress={onHistory}>
          <Text style={styles.link}>History</Text>
        </Pressable>
      </View>
      {tasks.length === 0 ? <Text style={styles.sub}>No tasks yet.</Text> : null}
      {tasks.map((t) => (
        <Pressable key={t.id} style={styles.taskRow} onPress={() => onOpen(t.id)}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {t.text || 'Image task'}
          </Text>
          <Text style={styles.cardSub}>{t.status}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Composer({ session, device, onBack, onSent }) {
  const [text, setText] = useState('');
  const [modelId, setModelId] = useState('auto');
  const [mode, setMode] = useState('agent');
  const [images, setImages] = useState([]);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const online = isOnline(device);
  const addImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!picked.canceled && images.length < 4) setImages([...images, picked.assets[0]]);
  };
  const send = async () => {
    if (!text.trim() && !images.length) return;
    setBusy(true);
    setMsg('');
    try {
      const taskId = 't' + Date.now().toString(36);
      const imageUrls = [];
      for (const img of images) imageUrls.push(await uploadImage(session, taskId, img));
      await writeDoc(session, 'tasks/' + taskId, {
        taskId,
        deviceId: device.id,
        text: text.trim(),
        modelId,
        mode,
        status: 'queued',
        phase: '',
        steps: [],
        files: [],
        summary: '',
        error: '',
        imageUrls,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'pocket',
      });
      onSent(taskId);
    } catch (err) {
      setMsg(err.message);
    }
    setBusy(false);
  };
  const model = MODELS.find((m) => m.id === modelId);
  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.pad}>
        <Pressable onPress={onBack}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
        <Text style={styles.h1}>New task</Text>
        <Text style={styles.sub}>
          {device?.name || 'PC'} · {online ? 'Online' : 'Queued until the PC is on'}
        </Text>
        <TextInput
          value={text}
          onChangeText={(t) => setText(t.slice(0, 8000))}
          placeholder="What should OLKIL do?"
          placeholderTextColor={MUTED}
          multiline
          style={styles.input}
        />
        <View style={styles.row}>
          <Pressable style={styles.pill} onPress={() => setSheet(true)}>
            <Text style={styles.pillText}>{model?.label || 'Auto'}</Text>
          </Pressable>
          <Pressable style={styles.pill} onPress={() => setMode(mode === 'agent' ? 'ask' : 'agent')}>
            <Text style={styles.pillText}>{mode === 'agent' ? 'Agent' : 'Ask'}</Text>
          </Pressable>
          <Pressable style={styles.pill} onPress={addImage}>
            <Text style={styles.pillText}>Image</Text>
          </Pressable>
        </View>
        <View style={styles.row}>
          {images.map((img, i) => (
            <Pressable key={img.uri} onPress={() => setImages(images.filter((_, n) => n !== i))}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
            </Pressable>
          ))}
        </View>
        {msg ? <Text style={styles.err}>{msg}</Text> : null}
      </ScrollView>
      <Pressable style={[styles.send, (!text.trim() && !images.length) || busy ? styles.disabled : null]} onPress={send}>
        <Text style={styles.primaryText}>{busy ? '…' : '↑'}</Text>
      </Pressable>
      {sheet ? (
        <View style={styles.sheet}>
          {MODELS.map((m) => (
            <Pressable
              key={m.id}
              style={styles.taskRow}
              onPress={() => {
                setModelId(m.id);
                setSheet(false);
              }}
            >
              <Text style={styles.cardTitle}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Run({ session, task, device, onBack }) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const files = Array.isArray(task.files) ? task.files : [];
  const running = task.status === 'queued' || task.status === 'running';
  const stop = async () => {
    await writeDoc(session, 'tasks/' + task.id, { status: 'cancelled', updatedAt: new Date().toISOString() });
  };
  const phase = task.status === 'running' ? task.phase || 'Planning next moves' : '';
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Pressable onPress={onBack}>
        <Text style={styles.link}>Back</Text>
      </Pressable>
      <Text style={styles.kicker}>{String(task.status || '').toUpperCase()}</Text>
      <Text style={styles.h1}>{task.text || 'Task'}</Text>
      {task.status === 'queued' ? (
        <Text style={styles.sub}>{isOnline(device) ? 'Sending to your PC' : 'Waiting for your PC'}</Text>
      ) : null}
      {phase ? <Text style={styles.phase}>{phase}</Text> : null}
      {steps.map((s) => (
        <Text key={s.id || s.label} style={[styles.step, s.done && styles.stepDone]}>
          {s.done ? '✓  ' : '·  '}
          {s.label}
        </Text>
      ))}
      {files.map((f) => (
        <Text key={f.path} style={styles.file}>
          {(f.path || '').split(/[/\\]/).pop()}  <Text style={styles.add}>+{f.additions || 0}</Text>  <Text style={styles.del}>−{f.deletions || 0}</Text>
        </Text>
      ))}
      {task.status === 'done' && task.summary ? <Text style={styles.summary}>{task.summary}</Text> : null}
      {task.status === 'error' ? <Text style={styles.err}>{task.error || 'Something went wrong on the PC.'}</Text> : null}
      {running ? (
        <Pressable style={styles.stop} onPress={stop}>
          <Text style={styles.primaryText}>Stop</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function History({ tasks, onOpen, onBack }) {
  const [filter, setFilter] = useState('all');
  const rows = useMemo(() => {
    if (filter === 'running') return tasks.filter((t) => t.status === 'running' || t.status === 'queued');
    if (filter === 'done') return tasks.filter((t) => t.status === 'done');
    return tasks;
  }, [tasks, filter]);
  return (
    <View style={styles.flex}>
      <View style={styles.pad}>
        <Pressable onPress={onBack}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
        <Text style={styles.h1}>History</Text>
        <View style={styles.row}>
          {['all', 'running', 'done'].map((f) => (
            <Pressable key={f} style={[styles.pill, filter === f && styles.cardOn]} onPress={() => setFilter(f)}>
              <Text style={styles.pillText}>{f}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 40 }}
        renderItem={({ item }) => (
          <Pressable style={styles.taskRow} onPress={() => onOpen(item.id)}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.text || 'Task'}
            </Text>
            <Text style={styles.cardSub}>{item.status}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function Settings({ session, devices, onBack, onLink, onSignOut, onUnlink }) {
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Pressable onPress={onBack}>
        <Text style={styles.link}>Back</Text>
      </Pressable>
      <Text style={styles.h1}>Settings</Text>
      <Text style={styles.sub}>{session.email || session.name || 'Signed in'}</Text>
      {devices.map((d) => (
        <View key={d.id} style={styles.card}>
          <Text style={styles.cardTitle}>{d.name || 'PC'}</Text>
          <Pressable onPress={() => onUnlink(d.id)}>
            <Text style={styles.link}>Unlink</Text>
          </Pressable>
        </View>
      ))}
      <Pressable style={styles.primary} onPress={onLink}>
        <Text style={styles.primaryText}>Link another computer</Text>
      </Pressable>
      <Pressable style={styles.textBtn} onPress={onSignOut}>
        <Text style={styles.textBtnLabel}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  boot: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  pad: { padding: 22, paddingBottom: 48 },
  brand: { color: TEXT, fontSize: 28, fontWeight: '650', letterSpacing: 1.2 },
  brandSm: { color: TEXT, fontSize: 18, fontWeight: '650', letterSpacing: 1 },
  tag: { color: MUTED, marginTop: 8, marginBottom: 28, fontSize: 16 },
  h1: { color: TEXT, fontSize: 26, fontWeight: '650', marginTop: 12 },
  sub: { color: MUTED, marginTop: 8, marginBottom: 16, lineHeight: 20 },
  section: { color: MUTED, marginTop: 22, marginBottom: 8 },
  kicker: { color: PINK, letterSpacing: 1.4, fontSize: 12, fontWeight: '700', marginTop: 16 },
  primary: { backgroundColor: PINK, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center', marginTop: 8 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.45 },
  err: { color: '#ff8d8d', marginTop: 12, lineHeight: 20 },
  code: { color: TEXT, fontSize: 32, letterSpacing: 8, textAlign: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.12)', marginVertical: 24, paddingVertical: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: CARD, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  cardOn: { borderColor: 'rgba(255,45,140,0.7)' },
  cardTitle: { color: TEXT, fontSize: 15, fontWeight: '600' },
  cardSub: { color: MUTED, marginTop: 2, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 8, backgroundColor: '#555' },
  dotOn: { backgroundColor: '#3dd68c' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  link: { color: TEXT, fontSize: 14 },
  taskRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  input: { minHeight: 120, color: TEXT, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' },
  pill: { borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: CARD, marginTop: 12 },
  pillText: { color: TEXT, fontSize: 13 },
  thumb: { width: 56, height: 56, borderRadius: 10, marginTop: 12 },
  send: { position: 'absolute', right: 20, bottom: 24, width: 52, height: 52, borderRadius: 26, backgroundColor: PINK, alignItems: 'center', justifyContent: 'center' },
  sheet: { position: 'absolute', left: 16, right: 16, bottom: 16, backgroundColor: CARD, borderRadius: 18, padding: 12 },
  phase: { color: TEXT, fontSize: 15, marginVertical: 12 },
  step: { color: TEXT, fontSize: 14, marginBottom: 6 },
  stepDone: { color: MUTED },
  file: { color: TEXT, marginTop: 8 },
  add: { color: '#3dd68c' },
  del: { color: '#ff7b72' },
  summary: { color: TEXT, fontSize: 16, lineHeight: 24, marginTop: 18 },
  stop: { marginTop: 22, borderRadius: 999, paddingVertical: 12, alignItems: 'center', backgroundColor: '#2a2a2e' },
  textBtn: { marginTop: 18, alignItems: 'center' },
  textBtnLabel: { color: MUTED },
});
