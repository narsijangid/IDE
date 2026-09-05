import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { AppConfig } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import * as fs from 'fs';
import * as path from 'path';
import styles from './chat.view.module.less';
import loaderUrl from './multi-color-loader.svg';

const ROTATE_MS = 5000;
const FIRST_SWAP_MS = 550;
const READING_FILES_MS = 10000;
const READING_FILES_LABEL = 'Reading files…';

const SCRATCH_PHRASES = [
  'Thinking…',
  'Planning…',
  'Analyzing…',
  'Reasoning…',
  'Mapping approach…',
  'Understanding task…',
] as const;

const EXISTING_PHRASES = [
  'Thinking',
  'Exploring…',
  READING_FILES_LABEL,
  'Mapping project…',
  'Tracing dependencies…',
  'Navigating codebase…',
  'Inspecting code…',
  'Investigating…',
  'Identifying relevant files…',
] as const;

const GENERIC_LABELS = new Set([
  'thinking',
  'planning',
  'working',
  'agent thinking',
  'testing',
  'live test',
  '',
]);

const PROJECT_MARKERS = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  '.git',
];

const SOURCE_DIRS = new Set(['src', 'lib', 'app', 'pages', 'components', 'server', 'client']);

function normalizeLabel(label: string): string {
  return (label || '').replace(/…+$/g, '').trim().toLowerCase();
}

/** True when the backend is only showing a generic idle-thinking label. */
export function isGenericStatusLabel(label: string): boolean {
  const n = normalizeLabel(label);
  if (GENERIC_LABELS.has(n)) {
    return true;
  }
  // Live Test boot text must not freeze the shimmer/swap status bar.
  return /^(opening (test browser|chromium)|test browser (open|launched)|live test)\b/.test(n);
}

export function detectProjectContext(workspaceRoot: string): 'scratch' | 'existing' {
  if (!workspaceRoot) {
    return 'scratch';
  }
  try {
    if (!fs.existsSync(workspaceRoot)) {
      return 'scratch';
    }
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(workspaceRoot, marker))) {
        return 'existing';
      }
    }
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    const files = entries.filter((e) => !e.name.startsWith('.') && e.isFile());
    if (files.length >= 3) {
      return 'existing';
    }
    const dirs = entries.filter((e) => !e.name.startsWith('.') && e.isDirectory());
    if (dirs.some((d) => SOURCE_DIRS.has(d.name.toLowerCase()))) {
      return 'existing';
    }
  } catch {
    // ignore — treat as scratch
  }
  return 'scratch';
}

function pickRandomPhrase(phrases: readonly string[], avoid: string): string {
  if (!phrases.length) {
    return 'Thinking…';
  }
  if (phrases.length === 1) {
    return phrases[0];
  }
  let next = avoid;
  let guard = 0;
  while (next === avoid && guard++ < 24) {
    next = phrases[Math.floor(Math.random() * phrases.length)];
  }
  return next;
}

function phraseDuration(label: string, first: boolean): number {
  if (first) {
    return FIRST_SWAP_MS;
  }
  return label === READING_FILES_LABEL ? READING_FILES_MS : ROTATE_MS;
}

export function useWorkspaceRoot(): string {
  const workspaceService = useInjectable<IWorkspaceService>(IWorkspaceService);
  const appConfig = useInjectable<AppConfig>(AppConfig);

  return useMemo(() => {
    try {
      const roots = workspaceService?.tryGetRoots?.() || [];
      for (const root of roots) {
        const fsPath = new URI(root.uri).codeUri.fsPath;
        if (fsPath && fs.existsSync(fsPath)) {
          return fsPath;
        }
      }
      const ws = workspaceService?.workspace;
      if (ws?.uri) {
        const fsPath = new URI(ws.uri).codeUri.fsPath;
        if (fsPath && fs.existsSync(fsPath) && !/\.code-workspace$/i.test(fsPath)) {
          return fsPath;
        }
      }
    } catch {
      // fall through
    }
    const fromConfig = appConfig.workspaceDir || '';
    if (fromConfig && fs.existsSync(fromConfig)) {
      return fromConfig;
    }
    return '';
  }, [workspaceService, appConfig]);
}

export function useLiveStatusLabel(opts: {
  active: boolean;
  status: string;
  activityLabel?: string;
  workspaceRoot: string;
}): string {
  const { active, status, activityLabel, workspaceRoot } = opts;

  const realLabel = useMemo(() => {
    const fromActivity = (activityLabel || '').trim();
    const fromStatus = (status || '').trim();
    if (fromActivity && !isGenericStatusLabel(fromActivity)) {
      return fromActivity;
    }
    if (fromStatus && !isGenericStatusLabel(fromStatus)) {
      return fromStatus;
    }
    return fromActivity || fromStatus || 'Thinking';
  }, [activityLabel, status]);

  const useDecorative = active && isGenericStatusLabel(realLabel);

  const context = useMemo(() => detectProjectContext(workspaceRoot), [workspaceRoot]);
  const phrases = context === 'existing' ? EXISTING_PHRASES : SCRATCH_PHRASES;
  const phrasesKey = phrases.join('|');

  const [decorativeLabel, setDecorativeLabel] = useState(() => pickRandomPhrase(phrases, ''));

  useEffect(() => {
    if (!useDecorative) {
      return;
    }

    let current = pickRandomPhrase(phrases, '');
    setDecorativeLabel(current);
    let cancelled = false;
    let timer = 0;
    let first = true;

    const schedule = () => {
      if (cancelled) {
        return;
      }
      const wait = phraseDuration(current, first);
      first = false;
      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        current = pickRandomPhrase(phrases, current);
        setDecorativeLabel(current);
        schedule();
      }, wait);
    };

    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [useDecorative, phrasesKey]);

  if (!active) {
    return '';
  }
  if (!useDecorative) {
    return realLabel;
  }
  return decorativeLabel;
}

export function LiveStatusBar({ label }: { label: string }) {
  const prevRef = useRef('');
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (label && label !== prevRef.current) {
      prevRef.current = label;
      setAnimating(true);
      const t = window.setTimeout(() => setAnimating(false), 480);
      return () => window.clearTimeout(t);
    }
    prevRef.current = label;
    return undefined;
  }, [label]);

  if (!label) {
    return null;
  }

  return (
    <div className={styles.liveStatus} aria-live="polite">
      <img src={loaderUrl} className={styles.thinkingLoader} alt="" aria-hidden />
      <span
        key={label}
        className={`${styles.liveStatusText} ${animating ? styles.liveStatusTextSwap : ''}`}
      >
        {label}
      </span>
    </div>
  );
}

export function ThinkingLoader() {
  return <img src={loaderUrl} className={styles.thinkingLoader} alt="" aria-hidden />;
}
