import { parseOlkilAgentEngine, type OlkilAgentEngine } from '../common/agent-engine';
import type { ClineEngineRunRequest, ClineEngineRunState } from '../common';
import { getOlkilClineRuntime } from './cline-runtime.service';
import { getOlkilOpencodeRuntime, scheduleOpencodePrewarm } from './opencode-runtime.service';

export interface OlkilAgentRuntime {
  run(request: ClineEngineRunRequest): Promise<ClineEngineRunState>;
  getState(runId: string): ClineEngineRunState | Promise<ClineEngineRunState>;
  cancel(runId: string): boolean | Promise<boolean>;
}

export function resolveOlkilAgentEngine(): OlkilAgentEngine {
  return parseOlkilAgentEngine(process.env.OLKIL_AGENT_ENGINE);
}

export function getOlkilAgentRuntime(): OlkilAgentRuntime {
  if (resolveOlkilAgentEngine() === 'cline') {
    return getOlkilClineRuntime();
  }
  return getOlkilOpencodeRuntime();
}

/**
 * Warm the default engine after the extension host is listening.
 * OpenCode = spawn sidecar only. Cline stays cold (that import froze EH).
 */
export function scheduleAgentEnginePrewarm(): void {
  if (resolveOlkilAgentEngine() === 'cline') {
    return;
  }
  scheduleOpencodePrewarm();
}
