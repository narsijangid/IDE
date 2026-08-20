import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { AppConfig } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import * as fs from 'fs';
import * as path from 'path';
import styles from './chat.view.module.less';

const ROTATE_MS = 5000;
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

const GENERIC_LABELS = new Set(['thinking', 'planning', 'working', 'agent thinking', '']);

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
  return GENERIC_LABELS.has(normalizeLabel(label));
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

function phraseDuration(label: string): number {
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

    const schedule = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        current = pickRandomPhrase(phrases, current);
        setDecorativeLabel(current);
        schedule();
      }, phraseDuration(current));
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
  const prevRef = useRef(label);
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
      <span className={styles.liveStatusSpin} aria-hidden />
      <span
        key={label}
        className={`${styles.liveStatusText} ${animating ? styles.liveStatusTextSwap : ''}`}
      >
        {label}
      </span>
    </div>
  );
}
