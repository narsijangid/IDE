import {
  Domain,
  ComponentContribution,
  ComponentRegistry,
  ClientAppContribution,
} from '@opensumi/ide-core-browser';
import { OlkilMenuBarLogo } from './olkil-header';
import './olkil-activity-icon.less';

/**
 * Registers the menubar logo (before OLKIL text) via OpenSumi's
 * `@opensumi/ide-menu-bar-logo` slot.
 */
@Domain(ComponentContribution, ClientAppContribution)
export class OlkilBrandingContribution implements ComponentContribution, ClientAppContribution {
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
  }
}
