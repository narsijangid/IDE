import { app } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';

const UPDATE_FEED_URL = process.env.OLKIL_UPDATE_URL || 'https://updates.olkil.com';
/** Poll while the app is open. */
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const FOCUS_CHECK_COOLDOWN_MS = 90 * 1000;

let started = false;
let updateDownloaded = false;
let checking = false;
let lastCheckAt = 0;
let downloadedInfo: UpdateInfo | null = null;

function log(...args: unknown[]) {
  console.log('[olkil-updater]', ...args);
}

function isPackagedApp(): boolean {
  return app.isPackaged;
}

/**
 * Download updates in the background — never run NSIS on quit.
 *
 * electron-updater's NSIS path uninstalls the current app first, then runs
 * Setup.exe /S --updated. If that silent install is blocked (SmartScreen / AV)
 * OLKIL disappears from Search and Apps. That looked like auto-uninstall.
 *
 * Safe path: download only. Apply from a later signed installer / website
 * download. Never call quitAndInstall.
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
  autoUpdater.autoInstallOnAppQuit = false;
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
    log('update available — downloading (will not auto-uninstall)', info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    checking = false;
    log('up to date', info?.version);
  });

  autoUpdater.on('error', (err) => {
    checking = false;
    log('error (install left intact)', err?.message || err);
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent || 0);
    if (pct === 0 || pct === 100 || pct % 20 === 0) {
      log(`download ${pct}%`);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    updateDownloaded = true;
    downloadedInfo = info;
    log('update downloaded', info.version, '— not applying automatically (keeps this install intact)');
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

  setTimeout(() => check(true), 8_000);
  setInterval(() => check(true), CHECK_INTERVAL_MS);

  app.on('browser-window-focus', () => {
    check(false);
  });
}

export function checkForUpdatesNow(): void {
  if (!isPackagedApp() || updateDownloaded) {
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => log('manual check failed', err?.message || err));
}

export function getPendingUpdateVersion(): string | null {
  return updateDownloaded ? downloadedInfo?.version || null : null;
}
