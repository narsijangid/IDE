import { Autowired, Injectable } from '@opensumi/di';
import {
  ClientAppContribution,
  CommandContribution,
  CommandRegistry,
  ComponentContribution,
  ComponentRegistry,
  Domain,
  MaybePromise,
  URI,
  WithEventBus,
  getIcon,
} from '@opensumi/ide-core-browser';
import { MenuContribution, IMenuRegistry, MenuId } from '@opensumi/ide-core-browser/lib/menu/next';
import { IMessageService } from '@opensumi/ide-overlay';
import { IElectronRendererURLService, IElectronURLService } from '@opensumi/ide-core-common/lib/electron';
import { IResource, IResourceProvider, ResourceService } from '@opensumi/ide-editor';
import {
  BrowserEditorContribution,
  EditorComponentRegistry,
  EditorOpenType,
  WorkbenchEditorService,
} from '@opensumi/ide-editor/lib/browser';
import { IOlkilAuthService, OLKIL_ACCOUNT_SCHEME } from '../common';
import { OlkilAuthService } from './auth.service';
import { OlkilAccountView } from './account.view';
import { OlkilElectronHeaderBar } from './auth-header';
import {
  OLKIL_AUTH_OPEN_ACCOUNT,
  OLKIL_AUTH_SIGN_IN,
  OLKIL_AUTH_SIGN_OUT,
} from './commands';

export {
  OLKIL_AUTH_OPEN_ACCOUNT,
  OLKIL_AUTH_SIGN_IN,
  OLKIL_AUTH_SIGN_OUT,
} from './commands';

const OLKIL_ACCOUNT_COMPONENT_ID = 'olkil-account-preview';

@Injectable()
export class OlkilAccountResourceProvider extends WithEventBus implements IResourceProvider {
  readonly scheme: string = OLKIL_ACCOUNT_SCHEME;

  provideResource(uri: URI): MaybePromise<IResource<any>> {
    return {
      supportsRevive: true,
      name: 'OLKIL Account',
      icon: getIcon('setting'),
      uri,
    };
  }

  provideResourceSubname(): string | null {
    return null;
  }

  async shouldCloseResource(): Promise<boolean> {
    return true;
  }
}

@Domain(
  ClientAppContribution,
  CommandContribution,
  MenuContribution,
  ComponentContribution,
  BrowserEditorContribution,
)
export class OlkilAuthContribution
  implements
    ClientAppContribution,
    CommandContribution,
    MenuContribution,
    ComponentContribution,
    BrowserEditorContribution
{
  @Autowired(IOlkilAuthService)
  private readonly auth!: OlkilAuthService;

  @Autowired(IMessageService)
  private readonly messages!: IMessageService;

  @Autowired(IElectronURLService)
  private readonly urlService!: IElectronRendererURLService;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  @Autowired(OlkilAccountResourceProvider)
  private readonly accountResourceProvider!: OlkilAccountResourceProvider;

  async onDidStart() {
    await this.auth.init();

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

    this.urlService.on('open-url', async (payload: { url?: string } | string) => {
      const url = typeof payload === 'string' ? payload : payload?.url;
      await handleUrl(url);
    });

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

  /** Override electron title-bar so avatar sits left of window controls. */
  registerComponent(registry: ComponentRegistry) {
    registry.register(
      'electron-header',
      {
        id: 'electron-header',
        component: OlkilElectronHeaderBar,
      },
      {
        size: 27,
        containerId: 'electron-header',
      },
    );
  }

  registerResource(resourceService: ResourceService) {
    resourceService.registerResourceProvider(this.accountResourceProvider);
  }

  registerEditorComponent(editorComponentRegistry: EditorComponentRegistry) {
    editorComponentRegistry.registerEditorComponent({
      component: OlkilAccountView,
      uid: OLKIL_ACCOUNT_COMPONENT_ID,
      scheme: OLKIL_ACCOUNT_SCHEME,
    });

    editorComponentRegistry.registerEditorComponentResolver(OLKIL_ACCOUNT_SCHEME, (_, __, resolve) => {
      resolve([
        {
          type: EditorOpenType.component,
          componentId: OLKIL_ACCOUNT_COMPONENT_ID,
        },
      ]);
    });
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
          // User abandoned / re-clicked Sign in — don't show a scary error
          if (/cancel|timed out/i.test(msg)) {
            return;
          }
          this.messages.error(`Sign in failed: ${msg}`);
        }
      },
    });

    commands.registerCommand(OLKIL_AUTH_SIGN_OUT, {
      execute: async () => {
        await this.auth.signOut();
        this.messages.info('Signed out of OLKIL');
      },
    });

    commands.registerCommand(OLKIL_AUTH_OPEN_ACCOUNT, {
      execute: async () => {
        await this.editorService.open(new URI().withScheme(OLKIL_ACCOUNT_SCHEME), {
          preview: false,
          focus: true,
        });
      },
    });
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_AUTH_OPEN_ACCOUNT.id,
      group: '9_olkil',
      order: 0,
    });
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
}
