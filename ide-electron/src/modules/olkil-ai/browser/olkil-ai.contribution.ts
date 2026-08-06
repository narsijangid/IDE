import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Autowired } from '@opensumi/di';
import {
  AppConfig,
  ClientAppContribution,
  CommandContribution,
  CommandRegistry,
  ConfigProvider,
  Domain,
  KeybindingContribution,
  KeybindingRegistry,
} from '@opensumi/ide-core-browser';
import { MenuContribution, IMenuRegistry, MenuId } from '@opensumi/ide-core-browser/lib/menu/next';
import { IOlkilChatService, IOlkilChatUiService } from '../common';
import { OlkilAiOverlay } from './overlay';

export const OLKIL_AI_TOGGLE_COMMAND = {
  id: 'olkil.ai.toggle',
  label: 'Toggle OLKIL Agent Chat',
};

export const OLKIL_AI_MINIMIZE_COMMAND = {
  id: 'olkil.ai.minimize',
  label: 'Minimize OLKIL Agent Chat',
};

export const OLKIL_AI_INLINE_EDIT_COMMAND = {
  id: 'olkil.ai.inlineEdit',
  label: 'OLKIL Inline Edit (Cmd+K)',
};

const OVERLAY_ROOT_ID = 'olkil-ai-overlay-root';

/**
 * The agent lives in a floating overlay rather than a workbench slot: that keeps
 * the editor at full width, lets the panel fold itself into a corner pill when a
 * file is opened, and gives us full control over the transition.
 */
@Domain(ClientAppContribution, CommandContribution, KeybindingContribution, MenuContribution)
export class OlkilAiContribution
  implements ClientAppContribution, CommandContribution, KeybindingContribution, MenuContribution
{
  @Autowired(AppConfig)
  private appConfig!: AppConfig;

  @Autowired(IOlkilChatUiService)
  private ui!: IOlkilChatUiService;

  @Autowired(IOlkilChatService)
  private chat!: IOlkilChatService;

  private host?: HTMLDivElement;
  private reactRoot?: Root;

  onDidStart() {
    this.ui.init();
    this.mountOverlay();
  }

  onStop() {
    this.reactRoot?.unmount();
    this.reactRoot = undefined;
    this.host?.remove();
    this.host = undefined;
  }

  private mountOverlay() {
    if (this.host || document.getElementById(OVERLAY_ROOT_ID)) {
      return;
    }
    const host = document.createElement('div');
    host.id = OVERLAY_ROOT_ID;
    document.body.appendChild(host);
    this.host = host;

    this.reactRoot = createRoot(host);
    this.reactRoot.render(
      React.createElement(
        ConfigProvider,
        { value: this.appConfig },
        React.createElement(OlkilAiOverlay),
      ),
    );
  }

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(OLKIL_AI_TOGGLE_COMMAND, {
      execute: () => {
        if (this.ui.state === 'minimized') {
          this.ui.restore();
        } else {
          this.ui.toggle();
        }
      },
    });

    commands.registerCommand(OLKIL_AI_MINIMIZE_COMMAND, {
      execute: () => this.ui.minimize(),
    });

    commands.registerCommand(OLKIL_AI_INLINE_EDIT_COMMAND, {
      execute: async () => {
        if (this.ui.state === 'closed' || this.ui.state === 'minimized') {
          this.ui.restore();
        }
        const instruction = window.prompt(
          'OLKIL Inline Edit — describe the change for the selected code:',
          '',
        );
        if (instruction?.trim()) {
          await this.chat.inlineEdit(instruction.trim());
        }
      },
    });
  }

  registerKeybindings(keybindings: KeybindingRegistry) {
    keybindings.registerKeybinding({
      command: OLKIL_AI_TOGGLE_COMMAND.id,
      keybinding: 'ctrlcmd+l',
    });
    keybindings.registerKeybinding({
      command: OLKIL_AI_INLINE_EDIT_COMMAND.id,
      keybinding: 'ctrlcmd+k',
      when: 'editorTextFocus',
    });
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.MenubarViewMenu, {
      command: OLKIL_AI_TOGGLE_COMMAND.id,
      label: 'OLKIL Agent Chat',
      group: '5_panel',
    });
    menus.registerMenuItem(MenuId.MenubarViewMenu, {
      command: OLKIL_AI_INLINE_EDIT_COMMAND.id,
      label: 'OLKIL Inline Edit',
      group: '5_panel',
    });
  }
}
