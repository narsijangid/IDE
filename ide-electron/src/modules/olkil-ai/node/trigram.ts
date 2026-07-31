/**
 * Zoekt-inspired positional-less trigram index for local Electron.
 * Design notes from https://github.com/sourcegraph/zoekt (positional trigrams):
 * - index every 3-gram → document posting list
 * - query by intersecting rarest trigrams, then verify substring
 * A full positional index is ~3x corpus size. Inside Electron we use a fixed
 * 4096-bit trigram Bloom signature per file, then verify candidate contents.
 * This keeps a 100k-file project around 50 MB instead of multi-GB JS Maps.
 */

const MAX_TRIGRAMS_PER_DOC = 80_000;
const SIGNATURE_BYTES = 512;

export function extractTrigrams(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  if (normalized.length < 3) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i + 2 < normalized.length && out.length < MAX_TRIGRAMS_PER_DOC; i++) {
    const a = normalized.charCodeAt(i);
    const b = normalized.charCodeAt(i + 1);
    const c = normalized.charCodeAt(i + 2);
    // Skip control-heavy noise; keep letters/digits/common code punctuation.
    if (a < 32 || b < 32 || c < 32) continue;
    const tri = normalized.slice(i, i + 3);
    if (seen.has(tri)) continue;
    seen.add(tri);
    out.push(tri);
  }
  return out;
}

export function queryTrigrams(query: string): string[] {
  const q = query.toLowerCase().trim();
  if (q.length < 3) return [];
  const tris: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 2 < q.length; i++) {
    const tri = q.slice(i, i + 3);
    if (seen.has(tri)) continue;
    seen.add(tri);
    tris.push(tri);
  }
  return tris;
}

function hashes(trigram: string): number[] {
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < trigram.length; i++) {
    const code = trigram.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2, 33) ^ code;
  }
  return [
    h1 >>> 0,
    h2 >>> 0,
    (h1 + Math.imul(h2, 0x9e3779b1)) >>> 0,
  ];
}

export function buildTrigramSignature(text: string): string {
  const bytes = Buffer.alloc(SIGNATURE_BYTES);
  for (const tri of extractTrigrams(text)) {
    for (const hash of hashes(tri)) {
      const bit = hash % (SIGNATURE_BYTES * 8);
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bytes.toString('base64');
}

export function signatureMayContain(signature: string, query: string): boolean {
  const trigrams = queryTrigrams(query);
  if (!trigrams.length || !signature) return false;
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== SIGNATURE_BYTES) return false;
  for (const tri of trigrams) {
    for (const hash of hashes(tri)) {
      const bit = hash % (SIGNATURE_BYTES * 8);
      if ((bytes[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
    }
  }
  return true;
}
