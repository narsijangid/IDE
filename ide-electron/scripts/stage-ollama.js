/*
 * Stage only the Ollama *engine* into build/ollama for electron-builder.
 *
 * Never copy Ollama branding (app.ico), the tray/desktop app, or Inno Setup
 * leftovers — electron-builder treats `build/` as icon resources, so those
 * files steal OLKIL's installer/app icon on every pack.
 *
 * Usage: node scripts/stage-ollama.js
 *
 * Source:
 *   - Windows: %LOCALAPPDATA%/Programs/Ollama
 *   - macOS:   /Applications/Ollama.app/Contents/Resources
 *   - Linux:   directory containing the `ollama` binary
 * Override with OLLAMA_SRC=<dir-or-binary>.
 */
const fs = require('fs');
const path = require('path');

const destDir = path.join(__dirname, '..', 'build', 'ollama');

/** Ollama GUI / installer junk that must never enter `build/`. */
const SKIP_NAME =
  /^(app\.ico|.*\.ico|.*\.lnk|unins000(\..*)?|OllamaSetup\.exe|ollama app\.exe|app\.exe)$/i;

function shouldSkip(name) {
  return SKIP_NAME.test(name);
}

function copyEngineTree(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (shouldSkip(entry)) {
        continue;
      }
      copyEngineTree(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  if (shouldSkip(path.basename(src))) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function resolveSource() {
  if (process.env.OLLAMA_SRC) {
    return process.env.OLLAMA_SRC;
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return path.join(local, 'Programs', 'Ollama');
  }
  if (process.platform === 'darwin') {
    return '/Applications/Ollama.app/Contents/Resources';
  }
  for (const p of ['/usr/local/bin/ollama', '/usr/bin/ollama']) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return '/usr/local/bin/ollama';
}

function stageFromInstallDir(srcDir) {
  const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const exeSrc = path.join(srcDir, exeName);
  const libSrc = path.join(srcDir, 'lib');

  if (fs.existsSync(exeSrc)) {
    copyEngineTree(exeSrc, path.join(destDir, exeName));
  } else {
    // macOS Resources layout: binary may sit next to lib
    copyEngineTree(srcDir, destDir);
    return;
  }

  if (fs.existsSync(libSrc)) {
    copyEngineTree(libSrc, path.join(destDir, 'lib'));
  }
}

function stripBranding(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (shouldSkip(entry)) {
      fs.rmSync(full, { recursive: true, force: true });
      console.log('[stage-ollama] removed branding/installer file', entry);
      continue;
    }
    if (fs.statSync(full).isDirectory()) {
      stripBranding(full);
    }
  }
}

function main() {
  const src = resolveSource();
  if (!fs.existsSync(src)) {
    console.error(
      `[stage-ollama] Source not found: ${src}\n` +
        'Install Ollama first (https://ollama.com) or set OLLAMA_SRC to the binary/dir.',
    );
    process.exit(1);
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    stageFromInstallDir(src);
  } else {
    const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    copyEngineTree(src, path.join(destDir, exeName));
  }

  stripBranding(destDir);

  const leakedIco = fs.existsSync(path.join(destDir, 'app.ico'));
  if (leakedIco) {
    throw new Error('[stage-ollama] app.ico still present — refuse to stage Ollama branding into build/');
  }

  console.log(`[stage-ollama] Staged Ollama engine (no icons) into ${destDir}`);
}

main();
