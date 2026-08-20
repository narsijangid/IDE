import { classifyTask } from './task-router';
import { detectEnvironment, formatEnvironment } from './environment';
import { FailedCommandMemory } from './failed-commands';
import { ToolResultCache } from './tool-cache';
import { SessionState } from './session-state';
import { parallelExplore } from './parallel-explore';
import { createOlkilIntelligenceTools } from './olkil-tools';
import {
  wrapBashExecutor,
  wrapEditorExecutor,
  wrapReadExecutor,
  wrapSearchExecutor,
} from './wrap-executors';
import { compactMessagesForTurn } from './prepare-turn';
import { cleanupRunTemp, cleanupStaleTemp, ensureOlkilLayout } from './temp-workspace';
import { createTelemetry, noteToolBatch } from './telemetry';
import type { ActivitySink, CompactTaskContext, EnvironmentInfo, TaskRoute } from './types';
import type { AgentTelemetry } from './types';

export interface OrchestratorStart {
  runId: string;
  prompt: string;
  workspaceRoot: string;
  activeFile?: string;
  mode: 'agent' | 'plan' | 'ask';
  signal?: AbortSignal;
  onActivity?: ActivitySink;
}

export interface OrchestratorSession {
  route: TaskRoute;
  env: EnvironmentInfo;
  cache: ToolResultCache;
  session: SessionState;
  failures: FailedCommandMemory;
  telemetry: AgentTelemetry;
  context?: CompactTaskContext;
  wrapExecutors: (executors: any) => any;
  extraTools: any[];
  orchestrationRules: string;
  wrapPrompt: (prompt: string) => string;
  prepareTurn: (ctx: { iteration: number; messages: readonly any[] }) => { messages?: any[]; systemPrompt?: string } | undefined;
  noteLlmCall: () => void;
  noteTools: (names: string[]) => void;
  finish: (ok: boolean) => AgentTelemetry;
}

export async function startOrchestrator(input: OrchestratorStart): Promise<OrchestratorSession> {
  const started = Date.now();
  const route = classifyTask(input.prompt, { activeFile: input.activeFile });
  const telemetry = createTelemetry(input.runId, route.size);
  const env = detectEnvironment(input.workspaceRoot);
  const cache = new ToolResultCache();
  const session = new SessionState(input.prompt);
  const failures = new FailedCommandMemory();
  const envText = formatEnvironment(env);

  if (input.workspaceRoot) {
    try {
      ensureOlkilLayout(input.workspaceRoot);
      cleanupStaleTemp(input.workspaceRoot);
    } catch {
      // ignore
    }
  }

  const retrievalStarted = Date.now();
  let context: CompactTaskContext | undefined;
  const skipPrefetch =
    !input.workspaceRoot ||
    (route.size === 'simple' &&
      input.prompt.trim().length < 48 &&
      !input.activeFile &&
      !/\.(ts|tsx|js|jsx|py|java|go|cs)\b/i.test(input.prompt));
  if (!skipPrefetch) {
    try {
      context = await parallelExplore({
        prompt: input.prompt,
        workspaceRoot: input.workspaceRoot,
        activeFile: input.activeFile,
        route,
        envText,
        signal: input.signal,
        onActivity: input.onActivity,
      });
      telemetry.prefetchUsed = true;
      telemetry.filesExplored = context.filesExplored;
      telemetry.searches += context.searches;
      telemetry.contextChars = context.text.length;
      for (const file of context.relevantFiles) {
        session.noteRead(file.path);
      }
      if (context.reference) {
        session.noteDecision(`Reference implementation: ${context.reference.file}`);
      }
    } catch {
      telemetry.fallbackToPlainCline = true;
    }
  }
  telemetry.retrievalTimeMs = Date.now() - retrievalStarted;
  telemetry.planningTimeMs = Date.now() - started - telemetry.retrievalTimeMs;

  const extraTools = input.workspaceRoot
    ? createOlkilIntelligenceTools({
        cwd: input.workspaceRoot,
        cache,
        session,
        mode: input.mode,
      })
    : [];

  const orchestrationRules = [
    '# OLKIL agent',
    route.promptHint,
    `Task: ${route.size} (${route.reason}).`,
    route.size === 'simple'
      ? 'Evidence pack is complete. Edit now — zero additional searches unless a file is missing.'
      : 'Repository evidence is pre-loaded. Do not repeat those exact searches. Stop exploring when targets are known.',
    'Batch independent reads/searches/edits in ONE turn.',
    'Prefer surgical old_text/new_text patches. Never rewrite whole large files.',
    'Never repeat a failed command; use the suggested alternative.',
    env.shellKind === 'powershell' && env.powershellVersion && /^[12345]\./.test(env.powershellVersion)
      ? 'PowerShell 5.x: use [string]::Join not Join-String; prefer `;` over `&&`.'
      : '',
    env.gitRoot
      ? `Git root: ${env.gitRoot}. Use git -C that path.`
      : 'No git root detected.',
  ]
    .filter(Boolean)
    .join('\n');

  const wrapPrompt = (prompt: string) => {
    if (!context?.text) return prompt;
    return `${prompt}\n\n<repository_evidence>\n${context.text}\n</repository_evidence>`;
  };

  const prepareTurn = (ctx: { iteration: number; messages: readonly any[]; systemPrompt?: string }) => {
    telemetry.llmCalls += 1;
    const compacted = compactMessagesForTurn({ ...ctx, aggressive: route.size === 'simple' });
    const state = session.renderForTurn(ctx.iteration);
    if (!compacted && !state) return undefined;
    return {
      messages: compacted?.messages,
      systemPrompt: state ? `${ctx.systemPrompt || ''}\n\n${state}` : undefined,
    };
  };

  const wrapExecutors = (executors: any) => {
    if (!executors) return executors;
    return {
      ...executors,
      search: wrapSearchExecutor(executors.search, { cache, session }),
      readFile: wrapReadExecutor(executors.readFile, { cache, session, cwd: input.workspaceRoot }),
      editor: wrapEditorExecutor(executors.editor, {
        cwd: input.workspaceRoot,
        cache,
        session,
        runId: input.runId,
      }),
      bash: wrapBashExecutor(executors.bash, {
        cwd: input.workspaceRoot,
        env,
        failures,
        session,
      }),
    };
  };

  return {
    route,
    env,
    cache,
    session,
    failures,
    telemetry,
    context,
    wrapExecutors,
    extraTools,
    orchestrationRules,
    wrapPrompt,
    prepareTurn,
    noteLlmCall: () => {
      telemetry.llmCalls += 1;
    },
    noteTools: (names: string[]) => noteToolBatch(telemetry, names),
    finish: () => {
      telemetry.cacheHits = cache.hits;
      telemetry.cacheMisses = cache.misses;
      telemetry.totalTimeMs = Date.now() - started;
      if (input.workspaceRoot) {
        cleanupRunTemp(input.workspaceRoot, input.runId);
      }
      return telemetry;
    },
  };
}

export { tryFastPath } from './fast-path';
export { classifyTask, detectTaskIntent, extractTaskTerms, seedTermsForIntent } from './task-router';
export { detectEnvironment, findGitRoot, formatEnvironment } from './environment';
export { rewriteKnownBadCommand } from './failed-commands';
export { buildCompactContext, rankEvidence } from './context-builder';
export { relocateTempScript, isTempScriptName } from './temp-workspace';
export { compactMessagesForTurn } from './prepare-turn';
export { findReferencePattern } from './pattern-finder';
export { ToolResultCache } from './tool-cache';
