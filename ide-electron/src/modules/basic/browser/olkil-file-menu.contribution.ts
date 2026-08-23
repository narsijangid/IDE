import { Autowired } from '@opensumi/di';
import {
  ClientAppContribution,
  CommandContribution,
  CommandRegistry,
  CommandService,
  Domain,
  EDITOR_COMMANDS,
  FILE_COMMANDS,
  IElectronNativeDialogService,
  KeybindingContribution,
  KeybindingRegistry,
  URI,
  WORKSPACE_COMMANDS,
  isMacintosh,
} from '@opensumi/ide-core-browser';
import { IMenuRegistry, MenuContribution, MenuId } from '@opensumi/ide-core-browser/lib/menu/next';
import { IElectronMainLifeCycleService } from '@opensumi/ide-core-common/lib/electron';
import { WorkbenchEditorService } from '@opensumi/ide-editor/lib/browser';

export const OLKIL_NEW_WINDOW_COMMAND = {
  id: 'olkil.window.new',
  label: 'New Window',
};

export const OLKIL_NEW_AGENTS_WINDOW_COMMAND = {
  id: 'olkil.window.newAgents',
  label: 'New Agents Window',
};

export const OLKIL_NEW_WINDOW_PROFILE_DEFAULT_COMMAND = {
  id: 'olkil.window.newWithProfile.default',
  label: 'Default',
};

export const OLKIL_OPEN_FILE_COMMAND = {
  id: 'olkil.file.openFile',
  label: 'Open File...',
};

export const OLKIL_OPEN_FOLDER_COMMAND = {
  id: 'olkil.file.openFolder',
  label: 'Open Folder...',
};

export const OLKIL_OPEN_WORKSPACE_COMMAND = {
  id: 'olkil.file.openWorkspace',
  label: 'Open Workspace from File...',
};

const PROFILE_SUBMENU_ID = 'olkilWindowProfiles';

/**
 * Cursor/VS Code-style File menu: same-window Open Folder / Open Recent,
 * New Window for a separate instance, and no leading OLKIL app menu on Windows.
 */
@Domain(ClientAppContribution, CommandContribution, KeybindingContribution, MenuContribution)
export class OlkilFileMenuContribution
  implements ClientAppContribution, CommandContribution, KeybindingContribution, MenuContribution
{
  @Autowired(IMenuRegistry)
  private readonly menus!: IMenuRegistry;

  @Autowired(CommandService)
  private readonly commandService!: CommandService;

  @Autowired(IElectronMainLifeCycleService)
  private readonly lifeCycle!: IElectronMainLifeCycleService;

  @Autowired(IElectronNativeDialogService)
  private readonly nativeDialog!: IElectronNativeDialogService;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(OLKIL_NEW_WINDOW_COMMAND, {
      execute: () => this.openEmptyWindow(),
    });
    commands.registerCommand(OLKIL_NEW_AGENTS_WINDOW_COMMAND, {
      execute: () => this.openEmptyWindow(),
    });
    commands.registerCommand(OLKIL_NEW_WINDOW_PROFILE_DEFAULT_COMMAND, {
      execute: () => this.openEmptyWindow(),
    });
    commands.registerCommand(OLKIL_OPEN_FILE_COMMAND, {
      execute: () => this.openFilesInThisWindow(),
    });
    commands.registerCommand(OLKIL_OPEN_FOLDER_COMMAND, {
      execute: () =>
        this.commandService.executeCommand(FILE_COMMANDS.OPEN_FOLDER.id, { newWindow: false }),
    });
    commands.registerCommand(OLKIL_OPEN_WORKSPACE_COMMAND, {
      execute: () =>
        this.commandService.executeCommand(FILE_COMMANDS.OPEN_WORKSPACE.id, { newWindow: false }),
    });
  }

  registerKeybindings(keybindings: KeybindingRegistry) {
    keybindings.registerKeybinding({
      command: OLKIL_NEW_WINDOW_COMMAND.id,
      keybinding: 'ctrlcmd+shift+n',
    });
    keybindings.registerKeybinding({
      command: OLKIL_NEW_AGENTS_WINDOW_COMMAND.id,
      keybinding: 'ctrlcmd+alt+n',
    });
    keybindings.registerKeybinding({
      command: OLKIL_OPEN_FILE_COMMAND.id,
      keybinding: 'ctrlcmd+o',
    });
    keybindings.registerKeybinding({
      command: OLKIL_OPEN_FOLDER_COMMAND.id,
      keybinding: 'ctrlcmd+k ctrlcmd+o',
    });
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_NEW_WINDOW_COMMAND.id,
      group: '0_new',
      order: 1,
    });
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_NEW_AGENTS_WINDOW_COMMAND.id,
      group: '0_new',
      order: 2,
    });
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      submenu: PROFILE_SUBMENU_ID,
      label: 'New Window with Profile',
      group: '0_new',
      order: 3,
    });
    menus.registerMenuItem(PROFILE_SUBMENU_ID, {
      command: OLKIL_NEW_WINDOW_PROFILE_DEFAULT_COMMAND.id,
      group: '0_profile',
      order: 0,
    });

    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_OPEN_FILE_COMMAND.id,
      group: '1_open',
      order: 0,
    });
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_OPEN_FOLDER_COMMAND.id,
      group: '1_open',
      order: 1,
      when: 'config.application.supportsOpenFolder',
    });
    menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: OLKIL_OPEN_WORKSPACE_COMMAND.id,
      group: '1_open',
      order: 2,
      when: 'config.application.supportsOpenWorkspace',
    });
  }

  onDidStart() {
    if (!isMacintosh) {
      this.menus.removeMenubarItem(MenuId.MenubarAppMenu);
    }

    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, EDITOR_COMMANDS.NEW_UNTITLED_FILE.id);
    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, FILE_COMMANDS.OPEN_FOLDER.id);
    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, FILE_COMMANDS.OPEN_WORKSPACE.id);
    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, WORKSPACE_COMMANDS.ADD_WORKSPACE_FOLDER.id);
    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, WORKSPACE_COMMANDS.ADD_WORKSPACE_FOLDER.id);
    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, WORKSPACE_COMMANDS.SAVE_WORKSPACE_AS_FILE.id);
    this.menus.unregisterMenuItem(MenuId.MenubarFileMenu, WORKSPACE_COMMANDS.SAVE_WORKSPACE_AS_FILE.id);

    this.menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: {
        id: EDITOR_COMMANDS.NEW_UNTITLED_FILE.id,
        label: 'New Text File',
      },
      group: '0_new',
      order: 0,
    });
    this.menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: WORKSPACE_COMMANDS.ADD_WORKSPACE_FOLDER.id,
      label: 'Add Folder to Workspace...',
      group: '2_workspace',
      order: 0,
      when: 'config.workspace.supportMultiRootWorkspace',
    });
    this.menus.registerMenuItem(MenuId.MenubarFileMenu, {
      command: {
        id: WORKSPACE_COMMANDS.SAVE_WORKSPACE_AS_FILE.id,
        label: 'Save Workspace As...',
      },
      group: '2_workspace',
      order: 1,
      when: 'config.workspace.supportMultiRootWorkspace',
    });
  }

  private openEmptyWindow() {
    this.lifeCycle.openWorkspace('');
  }

  private async openFilesInThisWindow() {
    const paths = await this.nativeDialog.showOpenDialog({
      title: 'Open File',
      properties: ['openFile', 'multiSelections'],
    });
    if (!paths?.length) {
      return;
    }
    for (const filePath of paths) {
      await this.editorService.open(URI.file(filePath), { preview: false, focus: true });
    }
  }
}
