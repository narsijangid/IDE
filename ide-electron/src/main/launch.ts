import os from 'os';
import { join } from 'path';
import { app } from 'electron';
import { existsSync, statSync, ensureDir, readFileSync } from 'fs-extra';
import { ElectronMainApp } from '@opensumi/ide-core-electron-main';
import { isOSX, URI } from '@opensumi/ide-core-common';
import { MainModule } from './services';
import { OpenSumiDesktopMainModule } from './module';
import { WebviewElectronMainModule } from '@opensumi/ide-webview/lib/electron-main';
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { Injector } from '@opensumi/di';
import { IMainStorageService } from 'common/types';
import { MainStorageService } from './services/storage';
import { Constants } from 'common/constants';

const getResourcesPath = () => {
  const appPath = app.getAppPath();
  if (appPath.indexOf('app.asar') > -1) {
    return join(appPath, '..');
  }
  return appPath;
};

/** Load packaged olkil.env into process.env so the OpenSumi node child inherits Dazzlone keys. */
function hydrateEnvFromResources() {
  const resources = getResourcesPath();
  process.env.OLKIL_RESOURCES_PATH = resources;
  if (isOSX) {
    process.env.MAC_RESOURCES_PATH = resources;
  }
  const candidates = [join(resources, 'olkil.env'), join(resources, '..', 'olkil.env')];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    } catch {
      // try next
    }
  }
}

hydrateEnvFromResources();

export interface ThemeData {
  menuBarBackground?: string;
  sideBarBackground?: string;
  editorBackground?: string;
  panelBackground?: string;
  statusBarBackground?: string;
}

const getExtensionDir = () => join(getResourcesPath(), 'extensions');
const getUserExtensionDir = () => join(join(os.homedir(), Constants.DATA_FOLDER), 'extensions');

const injector = new Injector([
  {
    token: IMainStorageService,
    useClass: MainStorageService,
  },
]);
const storage: IMainStorageService = injector.get(IMainStorageService);
const themeData: ThemeData = storage.getItemSync('theme');

async function init() {
  const electronApp: ElectronMainApp = new ElectronMainApp({
    injector,
    browserNodeIntegrated: true,
    browserUrl: URI.file(join(__dirname, '../browser/index.html')).toString(),
    // Do NOT pass uriScheme here — OpenSumi registers process.argv[1] which breaks
    // under `electron --inspect .` (System32 error). We register olkil:// ourselves
    // in main/index.ts with an absolute app path. Packaged builds still get the
    // protocol via electron-builder `protocols` in pack.js.
    modules: [MainModule, WebviewElectronMainModule, OpenSumiDesktopMainModule],
    nodeEntry: join(__dirname, '../node/index.js'),
    extensionEntry: join(__dirname, '../extension/index.js'),
    extensionWorkerEntry: join(__dirname, '../extension/index.worker.js'),
    webviewPreload: join(__dirname, '../webview/host-preload.js'),
    plainWebviewPreload: join(__dirname, '../webview/plain-preload.js'),
    browserPreload: join(__dirname, '../browser/preload.js'),
    extensionDir: getExtensionDir(),
    extensionCandidate: [],
    overrideBrowserOptions: {
      backgroundColor: themeData?.editorBackground || Constants.DEFAULT_BACKGROUND,
      trafficLightPosition: { x: 9, y: 6 },
      // Resolved from app/main → app/browser/assets (copied by webpack)
      icon: join(__dirname, '../browser/assets/olkil-logo.png'),
    },
    overrideWebPreferences: {},
  });
  await Promise.all([ensureDir(getExtensionDir()), ensureDir(getUserExtensionDir())]);
  return electronApp;
}

const initPromise = init();

export async function launch(workspace?: string) {
  console.log('workspace', workspace);

  const electronApp = await initPromise;
  await Promise.all([electronApp.init(), app.whenReady()]);

  if (process.env.OPENSUMI_DEVTOOLS === 'true') {
    await installExtension(REACT_DEVELOPER_TOOLS, {
      loadExtensionOptions: { allowFileAccess: true },
      forceDownload: true,
    })
      .then((name) => console.log(`Added Extension:  ${name}`))
      .catch((err) => console.error('An error occurred: ', err));
  }

  const codeWindows = electronApp.getCodeWindows();

  if (!workspace || !existsSync(workspace)) {
    if (codeWindows[1]) {
      return codeWindows[1].getBrowserWindow().show();
    }

    electronApp.loadWorkspace(undefined, undefined);
    return;
  }

  const workspaceStat = statSync(workspace);
  if (workspaceStat.isDirectory()) {
    const workspaceURI = URI.file(workspace);

    for (const window of codeWindows) {
      if (window.workspace?.isEqual(workspaceURI)) {
        return window.getBrowserWindow().show();
      }
    }

    electronApp.loadWorkspace(workspaceURI.toString(), undefined);
    return;
  }

  if (codeWindows.length) {
    codeWindows[0].getBrowserWindow().focus();
    codeWindows[0].getBrowserWindow().webContents.send('openFile', workspace);
    return;
  }

  electronApp.loadWorkspace(undefined, { launchToOpenFile: workspace });
}
