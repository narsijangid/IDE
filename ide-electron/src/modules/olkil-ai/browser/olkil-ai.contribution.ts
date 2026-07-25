import { Autowired } from '@opensumi/di';
import {
  ClientAppContribution,
  CommandContribution,
  CommandRegistry,
  ComponentContribution,
  ComponentRegistry,
  Domain,
  KeybindingContribution,
  KeybindingRegistry,
  SlotLocation,
} from '@opensumi/ide-core-browser';
import { IMainLayoutService } from '@opensumi/ide-main-layout';
import { MenuContribution, IMenuRegistry, MenuId } from '@opensumi/ide-core-browser/lib/menu/next';
import { OLKIL_AI_CONTAINER_ID, OLKIL_AI_ID } from '../common';
import { OlkilAiChatView } from './chat.view';

export const OLKIL_AI_TOGGLE_COMMAND = {
  id: 'olkil.ai.toggle',
  label: 'Toggle OLKIL Agent Chat',
};

@Domain(
  ClientAppContribution,
  ComponentContribution,
  CommandContribution,
  KeybindingContribution,
  MenuContribution,
)
export class OlkilAiContribution
  implements
    ClientAppContribution,
    ComponentContribution,
    CommandContribution,
    KeybindingContribution,
    MenuContribution
{
  @Autowired(IMainLayoutService)
  private layoutService!: IMainLayoutService;

  onDidStart() {
    // Keep right panel closed by default for a clean first paint
  }

  registerComponent(registry: ComponentRegistry) {
    registry.register(OLKIL_AI_ID, [], {
      containerId: OLKIL_AI_CONTAINER_ID,
      iconClass: 'olkil-activity-icon',
      title: 'OLKIL Agent',
      component: OlkilAiChatView,
      priority: 0,
      activateKeyBinding: 'ctrlcmd+l',
      expanded: true,
    });
  }

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(OLKIL_AI_TOGGLE_COMMAND, {
      execute: () => {
        const handler = this.layoutService.getTabbarHandler(OLKIL_AI_CONTAINER_ID);
        if (!handler) {
          this.layoutService.toggleSlot(SlotLocation.right, true);
          return;
        }
        if (handler.isActivated()) {
          this.layoutService.toggleSlot(SlotLocation.right, false);
        } else {
          this.layoutService.toggleSlot(SlotLocation.right, true, 360);
          handler.activate();
        }
      },
    });
  }

  registerKeybindings(keybindings: KeybindingRegistry) {
    keybindings.registerKeybinding({
      command: OLKIL_AI_TOGGLE_COMMAND.id,
      keybinding: 'ctrlcmd+l',
    });
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.MenubarViewMenu, {
      command: OLKIL_AI_TOGGLE_COMMAND.id,
      label: 'OLKIL Agent Chat',
      group: '5_panel',
    });
  }
}
