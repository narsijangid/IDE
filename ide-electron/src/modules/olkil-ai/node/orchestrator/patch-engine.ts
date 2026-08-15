import * as fs from 'fs';
import * as path from 'path';

export interface PatchVerifyResult {
  ok: boolean;
  message: string;
  redirectedPath?: string;
}

export function verifyOldText(content: string, oldText: string): { ok: boolean; hint?: string } {
  if (content.includes(oldText)) {
    return { ok: true };
  }
  const relaxed = oldText.replace(/\r\n/g, '\n').trim();
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized.includes(relaxed)) {
    return { ok: true };
  }
  const firstLine = relaxed.split('\n')[0]?.trim() || '';
  if (firstLine.length > 12) {
    const idx = normalized.split('\n').findIndex((line) => line.includes(firstLine.slice(0, 40)));
    if (idx >= 0) {
      return {
        ok: false,
        hint: `old_text not found exactly. Nearby at line ${idx + 1}: ${normalized.split('\n')[idx].slice(0, 160)}. Re-read that range and retry with an exact unique snippet.`,
      };
    }
  }
  return {
    ok: false,
    hint: 'old_text not found. Re-read the current file — do not retry the same snippet.',
  };
}

export function verifyNewText(content: string, newText: string): boolean {
  if (!newText) return true;
  if (content.includes(newText)) return true;
  return content.replace(/\r\n/g, '\n').includes(newText.replace(/\r\n/g, '\n').trim());
}

export function readFileText(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}
