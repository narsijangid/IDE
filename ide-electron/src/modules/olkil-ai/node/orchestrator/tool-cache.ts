import * as fs from 'fs';
import * as path from 'path';

interface CacheEntry<T> {
  value: T;
  at: number;
  mtimeMs?: number;
}

const MAX = 400;

export class ToolResultCache {
  private reads = new Map<string, CacheEntry<string>>();
  private searches = new Map<string, CacheEntry<string>>();
  hits = 0;
  misses = 0;

  private touch<T>(map: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>) {
    if (map.size >= MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, entry);
  }

  getRead(absPath: string, start?: number | null, end?: number | null): string | undefined {
    const key = readKey(absPath, start, end);
    const hit = this.reads.get(key);
    if (!hit) {
      this.misses += 1;
      return undefined;
    }
    try {
      const mtime = fs.statSync(absPath).mtimeMs;
      if (hit.mtimeMs != null && Math.abs(mtime - hit.mtimeMs) > 1) {
        this.reads.delete(key);
        this.misses += 1;
        return undefined;
      }
    } catch {
      this.reads.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return hit.value;
  }

  setRead(absPath: string, value: string, start?: number | null, end?: number | null) {
    let mtimeMs: number | undefined;
    try {
      mtimeMs = fs.statSync(absPath).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    this.touch(this.reads, readKey(absPath, start, end), {
      value,
      at: Date.now(),
      mtimeMs,
    });
  }

  getSearch(root: string, query: string): string | undefined {
    const hit = this.searches.get(searchKey(root, query));
    if (!hit) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() - hit.at > 45_000) {
      this.searches.delete(searchKey(root, query));
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return hit.value;
  }

  setSearch(root: string, query: string, value: string) {
    this.touch(this.searches, searchKey(root, query), { value, at: Date.now() });
  }

  invalidatePath(absPath: string) {
    const needle = path.resolve(absPath).toLowerCase();
    for (const key of [...this.reads.keys()]) {
      if (key.toLowerCase().startsWith(needle)) {
        this.reads.delete(key);
      }
    }
    this.searches.clear();
  }

  invalidateRoot(_root?: string) {
    this.reads.clear();
    this.searches.clear();
  }
}

function readKey(absPath: string, start?: number | null, end?: number | null): string {
  return `${path.resolve(absPath)}:${start ?? ''}:${end ?? ''}`;
}

function searchKey(root: string, query: string): string {
  return `${path.resolve(root).toLowerCase()}|${query}`;
}
