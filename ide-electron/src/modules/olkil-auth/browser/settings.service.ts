import { Autowired, Injectable } from '@opensumi/di';
import { Disposable, Emitter, Event } from '@opensumi/ide-core-common';
import { PreferenceScope, PreferenceService } from '@opensumi/ide-core-browser';
import { IThemeService } from '@opensumi/ide-theme';
import { IMainStorageService } from 'common/types';
import {
  DEFAULT_OLKIL_SETTINGS,
  IOlkilSettingsService,
  OLKIL_SETTINGS_STORAGE_KEY,
  OlkilSettings,
  mergeOlkilSettings,
} from '../common/settings';

const MAIN_STORAGE_NAME = 'olkil-settings';

@Injectable()
export class OlkilSettingsService extends Disposable implements IOlkilSettingsService {
  @Autowired(PreferenceService)
  private readonly prefs!: PreferenceService;

  @Autowired(IThemeService)
  private readonly themeService!: IThemeService;

  @Autowired(IMainStorageService)
  private readonly mainStorage!: IMainStorageService;

  private readonly _onDidChange = new Emitter<OlkilSettings>();
  readonly onDidChange: Event<OlkilSettings> = this._onDidChange.event;

  private value: OlkilSettings = { ...DEFAULT_OLKIL_SETTINGS };
  private ready = false;

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
