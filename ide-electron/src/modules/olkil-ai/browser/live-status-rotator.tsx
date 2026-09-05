import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { AppConfig } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import * as fs from 'fs';
import styles from './chat.view.module.less';
import loaderUrl from './multi-color-loader.svg';

/** Shown while the model is deciding — never fake file/repo work. */
export const PLANNING_LABEL = 'Planning next move';

const GENERIC_LABELS = new Set([
  'planning',
  'planning next move',
  'working',
  'thinking',
  'replying',
  'reasoning',
  'analyzing',
  'understanding task',
  'mapping approach',
  'mapping project',
  'exploring',
  'investigating',
  'agent thinking',
  'testing',
  'live test',
  '',
]);

function normalizeLabel(label: string): string {
  return (label || '').replace(/…+$/g, '').trim().toLowerCase();
}

/** True when the backend is idle-thinking, not running a real tool. */
export function isGenericStatusLabel(label: string): boolean {
  return GENERIC_LABELS.has(normalizeLabel(label));
}

/** Hide the footer spinner once the reply is already on screen. */
export function shouldShowLiveStatusBar(opts: {
  active: boolean;
  status: string;
  activityLabel?: string;
  hasVisibleReply?: boolean;
}): boolean {
  if (!opts.active) {
    return false;
  }
  const activity = (opts.activityLabel || '').trim();
  if (activity && !isGenericStatusLabel(activity)) {
    return true;
  }
  if (!opts.hasVisibleReply) {
    return true;
  }
  const status = normalizeLabel(opts.status);
  if (!status || isGenericStatusLabel(opts.status) || status === 'writing' || status === 'done' || status === 'stopped') {
    return false;
  }
  return true;
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
  workspaceRoot?: string;
}): string {
  const { active, status, activityLabel } = opts;

  if (!active) {
    return '';
  }

  const fromActivity = (activityLabel || '').trim();
  if (fromActivity && !isGenericStatusLabel(fromActivity)) {
    return fromActivity;
  }
  const fromStatus = (status || '').trim();
  if (fromStatus && !isGenericStatusLabel(fromStatus)) {
    return fromStatus;
  }
  return PLANNING_LABEL;
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
