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
  '--statusBar-background': '#fe019a',
  '--statusBar-foreground': '#ffffff',
  '--statusBar-noFolderBackground': '#fe019a',
  '--statusBar-noFolderForeground': '#ffffff',
  '--activityBar-background': '#000000',
  '--activityBarBadge-background': '#fe019a',
  '--activityBarBadge-foreground': '#ffffff',
  '--focusBorder': '#fe019a',
  '--badge-background': '#fe019a',
  '--badge-foreground': '#ffffff',
  '--progressBar-background': '#fe019a',
  '--button-background': '#fe019a',
  '--button-foreground': '#ffffff',
  '--button-hoverBackground': '#ff4db8',
  '--panelTitle-activeBorder': '#fe019a',
  '--tab-activeBorderTop': '#fe019a',
  '--activityBar-activeBorder': '#fe019a',
  '--sideBar-background': '#0d0d0d',
  '--editor-background': '#0a0a0a',
  '--panel-background': '#0a0a0a',
  '--kt-panelTab-activeForeground': '#fe019a',
  '--kt-panelTab-inactiveForeground': 'rgba(255,255,255,0.72)',
  '--tab-activeForeground': '#fe019a',
  '--textLink-foreground': '#fe019a',
  '--textLink-activeForeground': '#fe019a',
  '--terminal-offlineLinkForeground': '#fe019a',
};

function applyOlkilAccentVars() {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(OLKIL_ACCENT_VARS)) {
    root.style.setProperty(key, value);
  }
  const status = document.getElementById('statusBar');
  if (status) {
    status.style.background = '#fe019a';
    status.style.backgroundImage = 'none';
    status.style.color = '#ffffff';
  }
}

/**
 * Registers the menubar logo and locks Black + Pink (#fe019a) chrome.
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
    this.eventBus.on(ThemeChangedEvent, () => {
      window.requestAnimationFrame(applyOlkilAccentVars);
    });
  }
}
