import { app } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';

const UPDATE_FEED_URL = process.env.OLKIL_UPDATE_URL || 'https://updates.olkil.com';
/** Poll while the app is open. */
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const FOCUS_CHECK_COOLDOWN_MS = 90 * 1000;
/**
 * If an update was already downloaded (previous session) and we learn about it
 * right after launch, apply + relaunch immediately so "open OLKIL" lands on the
 * new version — no website reinstall, no dialog.
 */
const STARTUP_APPLY_WINDOW_MS = 20_000;
/**
 * Safety net: if the user never quits for a long time after download, apply
 * silently and relaunch (still no dialog / no website).
 */
const FORCE_APPLY_AFTER_MS = 60 * 60 * 1000;

let started = false;
let updateDownloaded = false;
let installing = false;
let checking = false;
let lastCheckAt = 0;
let downloadedInfo: UpdateInfo | null = null;
let appStartedAt = 0;
let forceApplyTimer: NodeJS.Timeout | null = null;

function log(...args: unknown[]) {
  console.log('[olkil-updater]', ...args);
}

function isPackagedApp(): boolean {
  return app.isPackaged;
}

function clearForceTimer() {
  if (forceApplyTimer) {
    clearTimeout(forceApplyTimer);
    forceApplyTimer = null;
  }
}

/**
 * Silent NSIS install. isForceRunAfter=true relaunches OLKIL automatically.
 * User never visits the website and never clicks Restart.
 */
function applyUpdateSilently(relaunch: boolean) {
  if (!updateDownloaded || installing) {
    return;
  }
  installing = true;
  clearForceTimer();
  const version = downloadedInfo?.version || '?';
  log(relaunch ? 'silent install + relaunch' : 'silent install (next open)', version);
  try {
    autoUpdater.quitAndInstall(true, relaunch);
  } catch (err) {
    installing = false;
    log('quitAndInstall failed', err);
  }
}

function onUpdateReady(info: UpdateInfo) {
  updateDownloaded = true;
  downloadedInfo = info;
  const sinceStart = Date.now() - appStartedAt;
  log('update ready', info.version, `t+${Math.round(sinceStart / 1000)}s`);

  // Opening the app with a pending/cached update → apply now so this session
  // becomes the new version (brief automatic relaunch, zero user action).
  if (sinceStart <= STARTUP_APPLY_WINDOW_MS) {
    log('pending update at startup — applying so this open is the new build');
    setTimeout(() => applyUpdateSilently(true), 800);
    return;
  }

  // Normal case: keep using the app; install when they quit. Next open = new features.
  log('downloaded in background — will install automatically on quit (or after long idle)');
  clearForceTimer();
  forceApplyTimer = setTimeout(() => {
    if (updateDownloaded && !installing) {
      log('long-running session — applying update in background');
      applyUpdateSilently(true);
    }
  }, FORCE_APPLY_AFTER_MS);
}

/**
 * Zero-click updates for installed OLKIL:
 * 1. Check feed on start + periodically
 * 2. Download in background (no UI)
 * 3. Install on quit → next open shows new features
 * 4. If update already waiting at startup → silent apply + relaunch
 *
 * Users never reinstall from olkil.com for normal updates.
 */
export function startAutoUpdater(): void {
  if (started) {
    return;
  }
  started = true;
  appStartedAt = Date.now();

  if (!isPackagedApp()) {
    log('skip — not a packaged build (dev mode)');
    return;
  }

  autoUpdater.autoDownload = true;
  // Primary path: when the user closes OLKIL, install quietly.
  // Next time they open the same installed app → new features.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  try {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_FEED_URL,
    });
  } catch (err) {
    log('setFeedURL failed', err);
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    checking = true;
    log('checking', UPDATE_FEED_URL);
  });

  autoUpdater.on('update-available', (info) => {
    checking = false;
    log('update available — downloading silently', info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    checking = false;
    log('up to date', info?.version);
  });

  autoUpdater.on('error', (err) => {
    checking = false;
    log('error', err?.message || err);
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent || 0);
    if (pct === 0 || pct === 100 || pct % 20 === 0) {
      log(`download ${pct}%`);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    onUpdateReady(info);
  });

  // Make quit-install reliable even if electron-updater's flag misses a path
  app.on('will-quit', () => {
    if (updateDownloaded && !installing) {
      log('quit — installing downloaded update for next launch');
      try {
        installing = true;
        // relaunch=false: user closed the app; next manual open is the new build
        autoUpdater.quitAndInstall(true, false);
      } catch (err) {
        log('install-on-quit failed', err);
      }
    }
  });

  const check = (force = false) => {
    const now = Date.now();
    if (checking || updateDownloaded || installing) {
      return;
    }
    if (!force && now - lastCheckAt < FOCUS_CHECK_COOLDOWN_MS) {
      return;
    }
    lastCheckAt = now;
    autoUpdater.checkForUpdates().catch((err) => log('check failed', err?.message || err));
  };

  // Immediate check so pending updates apply on open
  setTimeout(() => check(true), 1_500);
  setInterval(() => check(true), CHECK_INTERVAL_MS);

  app.on('browser-window-focus', () => {
    check(false);
  });
}

export function checkForUpdatesNow(): void {
  if (!isPackagedApp() || installing) {
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => log('manual check failed', err?.message || err));
}
