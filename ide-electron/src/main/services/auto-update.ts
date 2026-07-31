import { app, BrowserWindow } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';

const UPDATE_FEED_URL = process.env.OLKIL_UPDATE_URL || 'https://updates.olkil.com';
/** How often to poll the update feed while the app is open. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FOCUS_CHECK_COOLDOWN_MS = 2 * 60 * 1000;
/**
 * After an update finishes downloading, wait this long with no user input
 * before silently installing + relaunching (Cursor-style: no dialogs).
 */
const SILENT_APPLY_IDLE_MS = 45_000;
/** Absolute max wait after download before forcing a silent apply. */
const SILENT_APPLY_MAX_WAIT_MS = 10 * 60 * 1000;

let started = false;
let updateDownloaded = false;
let installing = false;
let checking = false;
let lastCheckAt = 0;
let lastUserActivityAt = Date.now();
let downloadedInfo: UpdateInfo | null = null;
let silentApplyTimer: NodeJS.Timeout | null = null;
let maxWaitTimer: NodeJS.Timeout | null = null;

function log(...args: unknown[]) {
  console.log('[olkil-updater]', ...args);
}

function isPackagedApp(): boolean {
  return app.isPackaged;
}

function markActivity() {
  lastUserActivityAt = Date.now();
}

function trackUserActivity() {
  app.on('browser-window-focus', markActivity);
  app.on('browser-window-blur', markActivity);
  for (const win of BrowserWindow.getAllWindows()) {
    win.on('focus', markActivity);
    win.webContents.on('before-input-event', markActivity);
  }
  app.on('browser-window-created', (_e, win) => {
    win.on('focus', markActivity);
    win.webContents.on('before-input-event', markActivity);
  });
}

function clearSilentTimers() {
  if (silentApplyTimer) {
    clearInterval(silentApplyTimer);
    silentApplyTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
}

/**
 * Install silently and relaunch. No dialogs — user does nothing.
 * Electron still needs one process restart to load new binaries; this does it automatically.
 */
function applyUpdateSilently() {
  if (!updateDownloaded || installing) {
    return;
  }
  installing = true;
  clearSilentTimers();
  const version = downloadedInfo?.version || '?';
  log('silent install + relaunch', version);
  try {
    // isSilent=true → NSIS runs quietly; isForceRunAfter=true → app reopens
    autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    installing = false;
    log('quitAndInstall failed', err);
  }
}

function scheduleSilentApply() {
  clearSilentTimers();
  log('update ready — will apply silently when idle (or within max wait)');

  // Prefer applying when the user hasn't touched the app for a bit
  silentApplyTimer = setInterval(() => {
    if (!updateDownloaded || installing) {
      return;
    }
    const idleFor = Date.now() - lastUserActivityAt;
    if (idleFor >= SILENT_APPLY_IDLE_MS) {
      log(`idle ${Math.round(idleFor / 1000)}s — applying update`);
      applyUpdateSilently();
    }
  }, 5_000);

  // Hard deadline so updates don't sit forever if the user is always active
  maxWaitTimer = setTimeout(() => {
    if (updateDownloaded && !installing) {
      log('max wait reached — applying update');
      applyUpdateSilently();
    }
  }, SILENT_APPLY_MAX_WAIT_MS);
}

/**
 * Fully automatic background updates (no reinstall, no "Restart?" dialog):
 * 1. Check feed on start + every few minutes
 * 2. Download in background
 * 3. Install silently when idle (or on quit) and relaunch
 */
export function startAutoUpdater(): void {
  if (started) {
    return;
  }
  started = true;

  if (!isPackagedApp()) {
    log('skip — not a packaged build (dev mode)');
    return;
  }

  autoUpdater.autoDownload = true;
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

  trackUserActivity();

  autoUpdater.on('checking-for-update', () => {
    checking = true;
    log('checking', UPDATE_FEED_URL);
  });

  autoUpdater.on('update-available', (info) => {
    checking = false;
    log('update available — downloading in background', info.version);
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
    if (pct === 0 || pct === 100 || pct % 25 === 0) {
      log(`download ${pct}%`);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    updateDownloaded = true;
    downloadedInfo = info;
    log('downloaded', info.version, '— scheduling silent apply');
    scheduleSilentApply();
  });

  // If the user quits before idle timer, still install on the way out
  app.on('before-quit', () => {
    if (updateDownloaded && !installing) {
      log('app quitting — installing downloaded update');
      try {
        installing = true;
        autoUpdater.quitAndInstall(true, false);
      } catch (err) {
        log('install-on-quit failed', err);
      }
    }
  });

  const check = (force = false) => {
    const now = Date.now();
    if (checking || updateDownloaded) {
      return;
    }
    if (!force && now - lastCheckAt < FOCUS_CHECK_COOLDOWN_MS) {
      return;
    }
    lastCheckAt = now;
    autoUpdater.checkForUpdates().catch((err) => log('check failed', err?.message || err));
  };

  // Soon after launch, then periodically
  setTimeout(() => check(true), 5_000);
  setInterval(() => check(true), CHECK_INTERVAL_MS);

  app.on('browser-window-focus', () => {
    check(false);
  });
}

export function checkForUpdatesNow(): void {
  if (!isPackagedApp()) {
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => log('manual check failed', err?.message || err));
}
