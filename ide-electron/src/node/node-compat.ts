/**
 * Electron 22 ships Node 16. The OLKIL engine (and sap-ai-provider / winston)
 * call APIs added in Node 20.12+. Patch them before any engine import so an
 * uncaught TypeError cannot kill the node process and restart the extension host.
 */
function patchStyleText(mod: { styleText?: unknown } | undefined): void {
  if (!mod || typeof mod.styleText === 'function') {
    return;
  }
  Object.defineProperty(mod, 'styleText', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (_format: unknown, text: unknown) => String(text ?? ''),
  });
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  patchStyleText(require('util'));
} catch {
  // ignore
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  patchStyleText(require('node:util'));
} catch {
  // ignore
}
