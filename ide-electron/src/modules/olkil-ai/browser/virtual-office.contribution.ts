import { Autowired, Injectable } from '@opensumi/di';
import {
  CommandContribution,
  CommandRegistry,
  Domain,
  MaybePromise,
  URI,
  WithEventBus,
  getIcon,
} from '@opensumi/ide-core-browser';
import { MenuContribution, IMenuRegistry, MenuId } from '@opensumi/ide-core-browser/lib/menu/next';
import { IMessageService } from '@opensumi/ide-overlay';
import { IResource, IResourceProvider, ResourceService } from '@opensumi/ide-editor';
import {
  BrowserEditorContribution,
  EditorComponentRegistry,
  EditorOpenType,
  WorkbenchEditorService,
} from '@opensumi/ide-editor/lib/browser';
import {
  IOlkilChatUiService,
  IOlkilVirtualOfficeService,
  OLKIL_VIRTUAL_OFFICE_SCHEME,
  OLKIL_VIRTUAL_OFFICE_URI,
} from '../common';
import { OlkilVirtualOfficeView } from './virtual-office.view';

export const OLKIL_VIRTUAL_OFFICE_OPEN = {
  id: 'olkil.virtualOffice.open',
  label: 'Virtual Office…',
};

export const OLKIL_VIRTUAL_OFFICE_EXIT = {
  id: 'olkil.virtualOffice.exit',
  label: 'Exit Virtual Office',
};

export const OLKIL_VIRTUAL_OFFICE_TOGGLE = {
  id: 'olkil.virtualOffice.toggle',
  label: 'Toggle Virtual Office',
};

const COMPONENT_ID = 'olkil-virtual-office';

@Injectable()
export class OlkilVirtualOfficeResourceProvider extends WithEventBus implements IResourceProvider {
  readonly scheme: string = OLKIL_VIRTUAL_OFFICE_SCHEME;

  @Autowired(IOlkilVirtualOfficeService)
  private readonly office!: IOlkilVirtualOfficeService;

  provideResource(uri: URI): MaybePromise<IResource<any>> {
    return {
      supportsRevive: true,
      name: 'Virtual Office',
      icon: getIcon('organization'),
      uri,
    };
  }

  provideResourceSubname(): string | null {
    return null;
  }

  async shouldCloseResource(): Promise<boolean> {
    this.office.exit();
    this.office.bindFrame(null);
    return true;
  }
}

@Domain(CommandContribution, MenuContribution, BrowserEditorContribution)
export class OlkilVirtualOfficeContribution
  implements CommandContribution, MenuContribution, BrowserEditorContribution
{
  @Autowired(IOlkilVirtualOfficeService)
  private readonly office!: IOlkilVirtualOfficeService;

  @Autowired(IOlkilChatUiService)
  private readonly chatUi!: IOlkilChatUiService;

  @Autowired(IMessageService)
  private readonly messages!: IMessageService;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  @Autowired(OlkilVirtualOfficeResourceProvider)
  private readonly resourceProvider!: OlkilVirtualOfficeResourceProvider;

  registerResource(resourceService: ResourceService) {
    resourceService.registerResourceProvider(this.resourceProvider);
  }

  registerEditorComponent(editorComponentRegistry: EditorComponentRegistry) {
    editorComponentRegistry.registerEditorComponent({
      component: OlkilVirtualOfficeView,
      uid: COMPONENT_ID,
      scheme: OLKIL_VIRTUAL_OFFICE_SCHEME,
    });
    editorComponentRegistry.registerEditorComponentResolver(OLKIL_VIRTUAL_OFFICE_SCHEME, (_, __, resolve) => {
      resolve([{ type: EditorOpenType.component, componentId: COMPONENT_ID }]);
    });
  }

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(OLKIL_VIRTUAL_OFFICE_OPEN, {
      execute: async () => {
        this.office.enter();
        await this.editorService.open(new URI(OLKIL_VIRTUAL_OFFICE_URI), {
          preview: false,
          focus: true,
        });
        try {
          this.chatUi.open();
          this.chatUi.setPinned(true);
        } catch {
          // optional
        }
        this.messages.info('Virtual Office — assign via chat. Click a teammate to inspect live work.');
      },
    });

    commands.registerCommand(OLKIL_VIRTUAL_OFFICE_EXIT, {
      execute: async () => {
        this.office.exit();
        this.office.bindFrame(null);
        await this.closeVirtualOfficeTabs();
        try {
          this.chatUi.setPinned(false);
        } catch {
          // optional
        }
        this.messages.info('Dev Studio — single agent mode restored.');
      },
    });

    commands.registerCommand(OLKIL_VIRTUAL_OFFICE_TOGGLE, {
      execute: async () => {
        if (this.office.active || this.hasVirtualOfficeTab()) {
          await commands.executeCommand(OLKIL_VIRTUAL_OFFICE_EXIT.id);
        } else {
          await commands.executeCommand(OLKIL_VIRTUAL_OFFICE_OPEN.id);
        }
      },
    });
  }

  private hasVirtualOfficeTab(): boolean {
    try {
      if (this.editorService.currentResource?.uri?.scheme === OLKIL_VIRTUAL_OFFICE_SCHEME) {
        return true;
      }
      return (this.editorService.getAllOpenedUris() || []).some(
        (uri) => uri.scheme === OLKIL_VIRTUAL_OFFICE_SCHEME,
      );
    } catch {
      return false;
    }
  }

  private async closeVirtualOfficeTabs() {
    const seen = new Set<string>();
    const uris: URI[] = [];
    const push = (uri?: URI | null) => {
      if (!uri || uri.scheme !== OLKIL_VIRTUAL_OFFICE_SCHEME) {
        return;
      }
      const key = uri.toString();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      uris.push(uri);
    };

    push(new URI(OLKIL_VIRTUAL_OFFICE_URI));
    push(new URI().withScheme(OLKIL_VIRTUAL_OFFICE_SCHEME));
    push(this.editorService.currentResource?.uri);
    try {
      for (const uri of this.editorService.getAllOpenedUris() || []) {
        push(uri);
      }
    } catch {
      // ignore
    }
    for (const group of this.editorService.editorGroups || []) {
      for (const resource of group.resources || []) {
        push(resource.uri);
      }
    }

    for (const uri of uris) {
      try {
        await this.editorService.close(uri, true);
      } catch {
        // tab may already be gone
      }
    }
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.MenubarViewMenu, {
      command: OLKIL_VIRTUAL_OFFICE_TOGGLE.id,
      group: '5_panel',
      order: 3,
    });
  }
}
