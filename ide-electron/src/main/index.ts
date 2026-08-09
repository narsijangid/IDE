import path from 'path';
import { app, BrowserWindow } from 'electron';
import { launch } from './launch';
import minimist from 'minimist';
import { existsSync } from 'fs-extra';
import { startAutoUpdater } from './services/auto-update';

const PROTOCOL = 'olkil';

/**
 * Absolute path to the Electron app root (folder with package.json).
 * OpenSumi's default registration uses process.argv[1], which breaks when
 * launched as `electron --inspect=9229 .` — Windows then starts electron.exe
 * from System32 and shows "Unable to find Electron app at C:\WINDOWS\system32".
 */
function getAppRoot(): string {
  // Packaged: resources/app.asar or resources/app
  // Dev (webpack): __dirname = <repo>/app/main → repo root is ../..
  const candidate = path.resolve(__dirname, '..', '..');
  if (existsSync(path.join(candidate, 'package.json'))) {
    return candidate;
  }
  return process.cwd();
}

/** Register olkil:// so deep-link fallback works in both packaged + yarn start. */
function registerProtocolClient() {
  try {
    if (process.defaultApp) {
      const appRoot = getAppRoot();
      // Important: pass ABSOLUTE app path, never "." (cwd becomes System32 on protocol launch)
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [appRoot]);
      console.log(`[olkil-auth] protocol registered (dev): ${PROTOCOL} → ${process.execPath} ${appRoot}`);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
      console.log(`[olkil-auth] protocol registered (packaged): ${PROTOCOL}`);
    }
  } catch (err) {
    console.warn('[olkil-auth] protocol registration failed', err);
  }
}

function findProtocolUrl(args: string[]): string | undefined {
  return args.map(String).find((arg) => new RegExp(`^${PROTOCOL}:\\/\\/`, 'i').test(arg));
}

/** Forward olkil:// into the already-running IDE window. */
function dispatchProtocolUrl(url: string) {
  const wins = BrowserWindow.getAllWindows();
  const win = BrowserWindow.getFocusedWindow() || wins[0];
  if (!win) {
    console.warn('[olkil-auth] no window for protocol URL', url);
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
  win.webContents.send('olkil:open-url', url);
  win.webContents.send('open-url', { url, windowId: win.id });
}

const launchFromCommandLine = (processArgv: string[], workingDirectory: string): Promise<void> => {
  console.log('processArgv', processArgv);

  const protocolUrl = findProtocolUrl(processArgv);
  if (protocolUrl) {
    dispatchProtocolUrl(protocolUrl);
    if (BrowserWindow.getAllWindows().length) {
      return Promise.resolve();
    }
    return launch();
  }

  const parsedArgs = minimist(processArgv);
  const _argv = parsedArgs['_'].map((arg) => String(arg)).filter((arg) => arg.length > 0);
  const [, , ...argv] = _argv;

  console.log('launch argv', argv);
  console.log('working directory', workingDirectory);

  if (argv.length === 0) {
    return launch();
  }

  try {
    const argvPath = path.resolve(argv[0]);
    // Ignore accidental System32 / bare electron paths from broken protocol launches
    if (/system32/i.test(argvPath) || !existsSync(argvPath)) {
      const workspace = path.resolve(workingDirectory, argv[0]);
      if (existsSync(workspace) && !/system32/i.test(workspace)) {
        return launch(workspace);
      }
      return launch();
    }
    return launch(argvPath);
  } catch (e) {
    console.error('parse argv error', e);
    return launch();
  }
};

const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
  // Another OLKIL is running — OS still spawned us for the protocol URL.
  // Forward happens on the primary via second-instance; we must exit cleanly.
  app.quit();
  process.exit(0);
}

app.on('second-instance', (_event, commandLine, workingDirectory) => {
  const url = findProtocolUrl(commandLine);
  if (url) {
    dispatchProtocolUrl(url);
    return;
  }
  launchFromCommandLine(commandLine, workingDirectory).catch(console.error);
});

// Register BEFORE ready so Windows protocol map is correct for this session
registerProtocolClient();

const coldProtocol = findProtocolUrl(process.argv);

app.whenReady().then(() => {
  // Re-register after ready (some Windows builds ignore pre-ready calls)
  registerProtocolClient();
  startAutoUpdater();
  if (coldProtocol) {
    setTimeout(() => dispatchProtocolUrl(coldProtocol), 1000);
  }
});

launchFromCommandLine(process.argv, process.cwd()).catch(console.error);
