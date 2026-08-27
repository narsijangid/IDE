/**
 * Playwright is shipped as one zip so NSIS does not extract hundreds of files.
 * Live Test / idle launch unpacks it next to app.asar once.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ZIP_NAME = 'playwright-modules.zip';
const DEST_NAME = 'playwright-modules';
const PROBE = path.join('node_modules', 'playwright', 'package.json');

function extractArchive(zip: string, dest: string): void {
  const tmp = `${dest}.extracting`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync('tar', ['-xf', zip, '-C', tmp], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 180000,
    });
  } catch {
    const q = (p: string) => p.replace(/'/g, "''");
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(tmp)}' -Force`,
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 180000 },
    );
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

function needsExtract(zip: string, dest: string): boolean {
  const probe = path.join(dest, PROBE);
  if (!fs.existsSync(probe)) {
    return true;
  }
  try {
    return fs.statSync(zip).mtimeMs > fs.statSync(probe).mtimeMs;
  } catch {
    return true;
  }
}

export function ensurePackagedAssets(resourcesPath: string): void {
  if (!resourcesPath) {
    return;
  }
  const zip = path.join(resourcesPath, ZIP_NAME);
  if (!fs.existsSync(zip)) {
    return;
  }
  const dest = path.join(resourcesPath, DEST_NAME);
  if (!needsExtract(zip, dest)) {
    return;
  }
  const started = Date.now();
  console.log('[olkil-assets] extracting', ZIP_NAME);
  extractArchive(zip, dest);
  console.log(`[olkil-assets] ${DEST_NAME} ready in ${Date.now() - started}ms`);
}
