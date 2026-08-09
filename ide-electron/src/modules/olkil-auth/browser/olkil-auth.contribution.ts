import { Autowired } from '@opensumi/di';
import {
  ClientAppContribution,
  CommandContribution,
  CommandRegistry,
  Domain,
  StatusBarAlignment,
  StatusBarEntryAccessor,
  IStatusBarService,
} from '@opensumi/ide-core-browser';
import { MenuContribution, IMenuRegistry, MenuId } from '@opensumi/ide-core-browser/lib/menu/next';
import { IMessageService } from '@opensumi/ide-overlay';
import { IElectronRendererURLService, IElectronURLService } from '@opensumi/ide-core-common/lib/electron';
import { IOlkilAuthService } from '../common';
import { OlkilAuthService } from './auth.service';

export const OLKIL_AUTH_SIGN_IN = {
  id: 'olkil.auth.signIn',
  label: 'Sign in to OLKIL…',
};

export const OLKIL_AUTH_SIGN_OUT = {
  id: 'olkil.auth.signOut',
  label: 'Sign out of OLKIL',
};

@Domain(ClientAppContribution, CommandContribution, MenuContribution)
export class OlkilAuthContribution
  implements ClientAppContribution, CommandContribution, MenuContribution
{
  @Autowired(IOlkilAuthService)
  private readonly auth!: OlkilAuthService;

  @Autowired(IMessageService)
  private readonly messages!: IMessageService;

  @Autowired(IStatusBarService)
  private readonly statusBar!: IStatusBarService;

  @Autowired(IElectronURLService)
  private readonly urlService!: IElectronRendererURLService;

  private statusEntry?: StatusBarEntryAccessor;

  async onDidStart() {
    await this.auth.init();
    this.renderStatus();
    this.auth.onDidChangeSession(() => this.renderStatus());

    const handleUrl = async (url?: string) => {
      if (!url) {
        return;
      }
      const handled = await this.auth.handleDeepLink(url);
      if (handled) {
        const user = this.auth.getUser();
        this.messages.info(`Signed in as ${user?.email || user?.displayName || 'OLKIL user'}`);
      }
    };

    // Deep-link fallback from OpenSumi URL service
    this.urlService.on('open-url', async (payload: { url?: string } | string) => {
      const url = typeof payload === 'string' ? payload : payload?.url;
      await handleUrl(url);
    });

    // Windows second-instance / cold-start bridge from main process
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ipcRenderer } = require('electron');
      ipcRenderer.on('olkil:open-url', (_event: unknown, url: string) => {
        void handleUrl(url);
      });
      ipcRenderer.on('open-url', (_event: unknown, payload: { url?: string } | string) => {
        const url = typeof payload === 'string' ? payload : payload?.url;
        void handleUrl(url);
      });
    } catch {
      // non-electron / sandboxed
    }
  }

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(OLKIL_AUTH_SIGN_IN, {
      execute: async () => {
        try {
          this.messages.info('Opening browser to sign in…');
          const session = await this.auth.signIn();
          this.messages.info(
            `Signed in as ${session.user.email || session.user.displayName || session.user.uid}`,
          );
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (!/cancel/i.test(msg)) {
            this.messages.error(`Sign in failed: ${msg}`);
          }
        }
      },
    });

    commands.registerCommand(OLKIL_AUTH_SIGN_OUT, {
      execute: async () => {
        await this.auth.signOut();
        this.messages.info('Signed out of OLKIL');
      },
    });
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_AUTH_SIGN_IN.id,
      group: '9_olkil',
      order: 1,
    });
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_AUTH_SIGN_OUT.id,
      group: '9_olkil',
      order: 2,
    });
  }

  private renderStatus() {
    const user = this.auth.getUser();
    const text = user
      ? `OLKIL · ${user.email || user.displayName || 'Signed in'}`
      : 'OLKIL · Sign in';
    const command = user ? OLKIL_AUTH_SIGN_OUT.id : OLKIL_AUTH_SIGN_IN.id;

    if (this.statusEntry) {
      this.statusEntry.update({
        text,
        alignment: StatusBarAlignment.RIGHT,
        priority: 1000,
        command,
        tooltip: user ? 'Sign out of OLKIL' : 'Sign in via olkil.com',
      });
      return;
    }

    this.statusEntry = this.statusBar.addElement('olkil-auth-status', {
      text,
      alignment: StatusBarAlignment.RIGHT,
      priority: 1000,
      command,
      tooltip: user ? 'Sign out of OLKIL' : 'Sign in via olkil.com',
    });
  }
}
