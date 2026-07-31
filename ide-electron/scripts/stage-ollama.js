/*
 * Stage the Ollama engine into build/ollama so electron-builder can bundle it.
 * This lets end users run OLKIL with free, unlimited, local AI — zero setup.
 *
 * Usage: node scripts/stage-ollama.js
 *
 * It copies from an existing local Ollama install:
 *   - Windows: %LOCALAPPDATA%/Programs/Ollama
 *   - macOS:   /Applications/Ollama.app/Contents/Resources  (ollama binary)
 *   - Linux:   the directory containing the `ollama` binary
 *
 * Override the source with OLLAMA_SRC=<dir-or-binary>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const destDir = path.join(__dirname, '..', 'build', 'ollama');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      // Skip the optional tray/desktop app + updater to keep size down.
      if (/^ollama app\.exe$/i.test(entry) || /^OllamaSetup\.exe$/i.test(entry)) {
        continue;
      }
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
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
  // Linux: locate the binary on PATH-ish common spots
  for (const p of ['/usr/local/bin/ollama', '/usr/bin/ollama']) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return '/usr/local/bin/ollama';
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
    copyRecursive(src, destDir);
  } else {
    // Single binary
    const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    copyRecursive(src, path.join(destDir, exeName));
  }

  console.log(`[stage-ollama] Staged Ollama into ${destDir}`);
  console.log('[stage-ollama] It will be bundled by `yarn pack` into resources/ollama.');
}

main();
