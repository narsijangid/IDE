import { Autowired, Injectable } from '@opensumi/di';
import { Disposable, Emitter, Event } from '@opensumi/ide-core-common';
import { PreferenceScope, PreferenceService } from '@opensumi/ide-core-browser';
import { IThemeService } from '@opensumi/ide-theme';
import { IMainStorageService } from 'common/types';
import { IOlkilAuthService, OLKIL_FIRESTORE_PROJECT } from '../common';
import {
  DEFAULT_OLKIL_SETTINGS,
  IOlkilSettingsService,
  OLKIL_SETTINGS_STORAGE_KEY,
  OlkilCustomModel,
  OlkilSettings,
  mergeCustomModelLists,
  mergeOlkilSettings,
} from '../common/settings';

const MAIN_STORAGE_NAME = 'olkil-settings';
const CUSTOM_MODELS_DOC = (uid: string) =>
  `projects/${OLKIL_FIRESTORE_PROJECT}/databases/(default)/documents/users/${encodeURIComponent(uid)}/data/customModels`;

@Injectable()
export class OlkilSettingsService extends Disposable implements IOlkilSettingsService {
  @Autowired(PreferenceService)
  private readonly prefs!: PreferenceService;

  @Autowired(IThemeService)
  private readonly themeService!: IThemeService;

  @Autowired(IMainStorageService)
  private readonly mainStorage!: IMainStorageService;

  @Autowired(IOlkilAuthService)
  private readonly auth!: IOlkilAuthService;

  private readonly _onDidChange = new Emitter<OlkilSettings>();
  readonly onDidChange: Event<OlkilSettings> = this._onDidChange.event;

  private value: OlkilSettings = { ...DEFAULT_OLKIL_SETTINGS };
  private ready = false;
  private cloudTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudUid: string | null = null;

  constructor() {
    super();
    this.value = this.readLocal();
  }

  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.ready = true;
    try {
      const disk = await this.mainStorage.getItem<Partial<OlkilSettings>>(MAIN_STORAGE_NAME);
      if (disk && typeof disk === 'object' && Object.keys(disk).length) {
        this.value = mergeOlkilSettings({ ...this.value, ...disk });
        this.writeLocal(this.value);
      }
    } catch {
      // Disk storage is optional.
    }
  }

  get(): OlkilSettings {
    return this.value;
  }

  patch(partial: Partial<OlkilSettings>): void {
    const next = mergeOlkilSettings({ ...this.value, ...partial });
    const prev = this.value;
    this.value = next;
    this.writeLocal(next);
    void this.writeDisk(next);
    void this.applyWorkbench(next, prev);
    this._onDidChange.fire(next);
    if (partial.customModels) {
      this.queueCloudWrite(next.customModels);
    }
  }

  reset(): void {
    this.patch({ ...DEFAULT_OLKIL_SETTINGS });
  }

  resetSection(keys: Array<keyof OlkilSettings>): void {
    const partial: Partial<OlkilSettings> = {};
    for (const key of keys) {
      (partial as any)[key] = DEFAULT_OLKIL_SETTINGS[key];
    }
    this.patch(partial);
  }

  async syncCustomModelsCloud(): Promise<void> {
    const user = this.auth.getUser();
    if (!user?.uid) {
      this.cloudUid = null;
      return;
    }
    const token = await this.auth.getValidIdToken();
    if (!token) {
      return;
    }
    try {
      const remote = await fetchCustomModelsDoc(token, user.uid);
      this.cloudUid = user.uid;
      const merged = mergeCustomModelLists(this.value.customModels || [], remote);
      const changed = JSON.stringify(merged) !== JSON.stringify(this.value.customModels || []);
      if (changed) {
        this.value = mergeOlkilSettings({ ...this.value, customModels: merged });
        this.writeLocal(this.value);
        void this.writeDisk(this.value);
        this._onDidChange.fire(this.value);
      }
      if (merged.length) {
        this.queueCloudWrite(merged);
      }
    } catch {
      this.cloudUid = user.uid;
    }
  }

  private queueCloudWrite(models: OlkilCustomModel[]) {
    if (this.cloudTimer) {
      clearTimeout(this.cloudTimer);
    }
    this.cloudTimer = setTimeout(() => {
      this.cloudTimer = null;
      void this.writeCustomModelsCloud(models);
    }, 800);
  }

  private async writeCustomModelsCloud(models: OlkilCustomModel[]) {
    const user = this.auth.getUser();
    if (!user?.uid) {
      return;
    }
    const token = await this.auth.getValidIdToken();
    if (!token) {
      return;
    }
    this.cloudUid = user.uid;
    try {
      await putCustomModelsDoc(token, user.uid, models);
    } catch {
      // Cloud sync is optional; localStorage / disk still hold the models.
    }
  }

  private readLocal(): OlkilSettings {
    try {
      const raw = window.localStorage.getItem(OLKIL_SETTINGS_STORAGE_KEY);
      if (!raw) {
        return { ...DEFAULT_OLKIL_SETTINGS };
      }
      return mergeOlkilSettings(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_OLKIL_SETTINGS };
    }
  }

  private writeLocal(value: OlkilSettings) {
    try {
      window.localStorage.setItem(OLKIL_SETTINGS_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // ignore quota / private mode
    }
  }

  private async writeDisk(value: OlkilSettings) {
    try {
      await this.mainStorage.setItem(MAIN_STORAGE_NAME, value);
    } catch {
      // ignore
    }
  }

  private async applyWorkbench(next: OlkilSettings, prev?: OlkilSettings) {
    const tasks: Array<Promise<unknown>> = [];
    const set = (key: string, value: unknown) => {
      tasks.push(Promise.resolve(this.prefs.set(key, value, PreferenceScope.User)));
    };

    if (!prev || prev.editorFontSize !== next.editorFontSize) {
      set('editor.fontSize', next.editorFontSize);
    }
    if (!prev || prev.editorTabSize !== next.editorTabSize) {
      set('editor.tabSize', next.editorTabSize);
    }
    if (!prev || prev.editorWordWrap !== next.editorWordWrap) {
      set('editor.wordWrap', next.editorWordWrap);
    }
    if (!prev || prev.editorMinimap !== next.editorMinimap) {
      set('editor.minimap', next.editorMinimap);
      set('editor.minimap.enabled', next.editorMinimap);
    }
    if (!prev || prev.editorFormatOnSave !== next.editorFormatOnSave) {
      set('editor.formatOnSave', next.editorFormatOnSave);
    }
    if (!prev || prev.filesAutoSave !== next.filesAutoSave) {
      set('files.autoSave', next.filesAutoSave);
    }
    if (!prev || prev.confirmDelete !== next.confirmDelete) {
      set('explorer.confirmDelete', next.confirmDelete);
    }
    if (!prev || prev.filesExclude !== next.filesExclude) {
      set('files.exclude', globsToExclude(next.filesExclude));
    }
    if (!prev || prev.colorTheme !== next.colorTheme) {
      set('general.theme', next.colorTheme);
      const apply = (this.themeService as any)?.applyTheme;
      if (typeof apply === 'function') {
        tasks.push(Promise.resolve(apply.call(this.themeService, next.colorTheme)));
      }
    }

    await Promise.all(tasks).catch(() => undefined);
  }
}

function globsToExclude(raw: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const glob = line.trim();
    if (glob && !glob.startsWith('#')) {
      out[glob] = true;
    }
  }
  return out;
}

async function fetchCustomModelsDoc(token: string, uid: string): Promise<OlkilCustomModel[]> {
  const url = `https://firestore.googleapis.com/v1/${CUSTOM_MODELS_DOC(uid)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Firestore GET ${res.status}`);
  }
  const json = (await res.json()) as { fields?: Record<string, unknown> };
  const models = decodeJs(json.fields?.models);
  return Array.isArray(models) ? (models as OlkilCustomModel[]) : [];
}

async function putCustomModelsDoc(token: string, uid: string, models: OlkilCustomModel[]): Promise<void> {
  const slim = models.map((m) => ({
    id: m.id,
    label: m.label,
    model: m.model,
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    enabled: m.enabled,
    updatedAt: m.updatedAt,
  }));
  const patchUrl =
    `https://firestore.googleapis.com/v1/${CUSTOM_MODELS_DOC(uid)}` +
    `?updateMask.fieldPaths=models&updateMask.fieldPaths=updatedAt`;
  const body = JSON.stringify({
    fields: {
      models: encodeJs(slim),
      updatedAt: encodeJs(Date.now()),
    },
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  let res = await fetch(patchUrl, { method: 'PATCH', headers, body, cache: 'no-store' });
  if (res.status === 404) {
    res = await fetch(`https://firestore.googleapis.com/v1/${CUSTOM_MODELS_DOC(uid)}`, {
      method: 'PATCH',
      headers,
      body,
      cache: 'no-store',
    });
  }
  if (!res.ok) {
    throw new Error(`Firestore PATCH ${res.status}`);
  }
}

function encodeJs(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeJs) } };
  }
  if (typeof value === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) {
        continue;
      }
      fields[k] = encodeJs(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function decodeJs(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, any>;
  if ('stringValue' in v) {
    return v.stringValue as string;
  }
  if ('integerValue' in v) {
    return Number(v.integerValue);
  }
  if ('doubleValue' in v) {
    return v.doubleValue as number;
  }
  if ('booleanValue' in v) {
    return v.booleanValue as boolean;
  }
  if ('nullValue' in v) {
    return null;
  }
  if ('arrayValue' in v) {
    const values = (v.arrayValue?.values as unknown[]) || [];
    return values.map(decodeJs);
  }
  if ('mapValue' in v) {
    const fields = (v.mapValue?.fields || {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, nested] of Object.entries(fields)) {
      out[k] = decodeJs(nested);
    }
    return out;
  }
  return null;
}

