/**
 * Coding-agent backend for OLKIL.
 *
 * Default is OpenCode (sidecar process). Cline remains vendored but isolated:
 * it is not loaded unless OLKIL_AGENT_ENGINE=cline.
 */
export type OlkilAgentEngine = 'opencode' | 'cline';

export const DEFAULT_OLKIL_AGENT_ENGINE: OlkilAgentEngine = 'opencode';

export function parseOlkilAgentEngine(raw?: string | null): OlkilAgentEngine {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'cline' || value === 'legacy') {
    return 'cline';
  }
  return 'opencode';
}
