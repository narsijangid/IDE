import { LayoutConfig, SlotLocation } from '@opensumi/ide-core-browser';

export const customLayoutConfig: LayoutConfig = {
  [SlotLocation.top]: {
    modules: ['@opensumi/ide-menu-bar', 'topbar', 'toolbar'],
  },
  [SlotLocation.action]: {
    modules: ['@opensumi/ide-toolbar-action'],
  },
  [SlotLocation.left]: {
    modules: [
      '@opensumi/ide-explorer',
      '@opensumi/ide-search',
      '@opensumi/ide-scm',
      '@opensumi/ide-extension-manager',
      '@opensumi/ide-debug',
    ],
  },
  // The OLKIL agent renders as a floating overlay (see `olkil-ai.contribution`),
  // so the right rail stays collapsed and the editor keeps the full width.
  [SlotLocation.right]: {
    modules: [],
  },
  [SlotLocation.main]: {
    modules: ['@opensumi/ide-editor'],
  },
  [SlotLocation.bottom]: {
    modules: [
      '@opensumi/ide-terminal-next',
      '@opensumi/ide-output',
      'debug-console',
      '@opensumi/ide-markers',
      '@opensumi/ide-refactor-preview',
    ],
  },
  [SlotLocation.statusBar]: {
    modules: ['@opensumi/ide-status-bar'],
  },
  [SlotLocation.extra]: {
    modules: ['breadcrumb-menu'],
  },
};
