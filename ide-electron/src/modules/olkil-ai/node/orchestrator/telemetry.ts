import type { AgentTelemetry, TaskSize } from './types';

export function createTelemetry(taskId: string, taskSize: TaskSize): AgentTelemetry {
  return {
    taskId,
    taskSize,
    llmCalls: 0,
    toolCalls: 0,
    parallelToolCalls: 0,
    sequentialToolCalls: 0,
    filesExplored: 0,
    filesRead: 0,
    searches: 0,
    contextChars: 0,
    cacheHits: 0,
    cacheMisses: 0,
    planningTimeMs: 0,
    retrievalTimeMs: 0,
    editingTimeMs: 0,
    validationTimeMs: 0,
    totalTimeMs: 0,
    prefetchUsed: false,
    fallbackToPlainCline: false,
  };
}

export function noteToolBatch(telemetry: AgentTelemetry, names: string[]) {
  telemetry.toolCalls += names.length;
  if (names.length > 1) telemetry.parallelToolCalls += names.length;
  else telemetry.sequentialToolCalls += names.length;
  for (const name of names) {
    const n = name.toLowerCase();
    if (/search|grep|find|investigate|definition|reference|module/.test(n)) telemetry.searches += 1;
    if (/read/.test(n)) telemetry.filesRead += 1;
  }
}
