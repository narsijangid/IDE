import {
  Domain,
  ComponentContribution,
  ComponentRegistry,
  ClientAppContribution,
} from '@opensumi/ide-core-browser';
import { Autowired } from '@opensumi/di';
import { IEventBus } from '@opensumi/ide-core-common';
import { ThemeChangedEvent } from '@opensumi/ide-theme/lib/common';
import { OlkilMenuBarLogo } from './olkil-header';
import './olkil-activity-icon.less';
import './olkil-theme.less';

const OLKIL_ACCENT_VARS: Record<string, string> = {
  '--statusBar-background': '#f0c000',
  '--statusBar-foreground': '#141414',
  '--statusBar-noFolderBackground': '#f0c000',
  '--statusBar-noFolderForeground': '#141414',
  '--activityBarBadge-background': '#f0c000',
  '--activityBarBadge-foreground': '#141414',
  '--focusBorder': '#f0c000',
  '--badge-background': '#f0c000',
  '--badge-foreground': '#141414',
  '--progressBar-background': '#f0c000',
  '--button-background': '#f0c000',
  '--button-foreground': '#141414',
  '--button-hoverBackground': '#ffd20a',
  '--panelTitle-activeBorder': '#f0c000',
  '--tab-activeBorderTop': '#f0c000',
  '--activityBar-activeBorder': '#f0c000',
};

function applyOlkilAccentVars() {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(OLKIL_ACCENT_VARS)) {
    root.style.setProperty(key, value);
  }
  const status = document.getElementById('statusBar');
  if (status) {
    status.style.backgroundColor = '#f0c000';
    status.style.color = '#141414';
  }
}

/**
 * Registers the menubar logo (before OLKIL text) via OpenSumi's
 * `@opensumi/ide-menu-bar-logo` slot, and locks Black + Yellow chrome accents.
 */
@Domain(ComponentContribution, ClientAppContribution)
export class OlkilBrandingContribution implements ComponentContribution, ClientAppContribution {
  @Autowired(IEventBus)
  private readonly eventBus: IEventBus;

  registerComponent(registry: ComponentRegistry) {
    registry.register('@opensumi/ide-menu-bar-logo', {
      id: '@opensumi/ide-menu-bar-logo',
      component: OlkilMenuBarLogo,
    }, {
      containerId: '@opensumi/ide-menu-bar-logo',
    });
  }

  onDidStart() {
    const href = (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null)?.href;
    if (!href) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = './assets/olkil-logo.png';
      document.head.appendChild(link);
    }

    applyOlkilAccentVars();
    // Theme swaps rewrite CSS vars — re-assert yellow accents after each change.
    this.eventBus.on(ThemeChangedEvent, () => {
      window.requestAnimationFrame(applyOlkilAccentVars);
    });
  }
}
