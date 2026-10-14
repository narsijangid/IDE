import type { ClineEngineRunRequest, ClineEngineRunState, EnginePermissionResponse } from '../common';
import { getOlkilOpencodeRuntime, scheduleOpencodePrewarm } from './opencode-runtime.service';

export interface OlkilAgentRuntime {
  run(request: ClineEngineRunRequest): Promise<ClineEngineRunState>;
  getState(runId: string): ClineEngineRunState | Promise<ClineEngineRunState>;
  cancel(runId: string): boolean | Promise<boolean>;
  replyPermission(runId: string, permissionId: string, response: EnginePermissionResponse): boolean | Promise<boolean>;
}

export function getOlkilAgentRuntime(): OlkilAgentRuntime {
  return getOlkilOpencodeRuntime();
}

/** Warm the OpenCode sidecar after the extension host is listening. */
export function scheduleAgentEnginePrewarm(): void {
  scheduleOpencodePrewarm(12_000);
}
