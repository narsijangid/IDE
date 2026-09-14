import * as vscode from 'vscode';
import { OlkilSidebarProvider } from './sidebar';

async function openOlkilChat() {
  try {
    await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
  } catch {
    /* vscode without auxiliary bar */
  }
  try {
    await vscode.commands.executeCommand('workbench.view.extension.olkil');
  } catch {
    await vscode.commands.executeCommand('olkil.sidebar.focus');
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new OlkilSidebarProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OlkilSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('olkil.chat.toggle', () => openOlkilChat()),
    vscode.commands.registerCommand('olkil.chat.new', () => provider.newChat()),
    vscode.commands.registerCommand('olkil.signIn', () => provider.signIn()),
    vscode.commands.registerCommand('olkil.signOut', () => provider.signOut()),
    vscode.commands.registerCommand('olkil.askSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      await openOlkilChat();
      await provider.ask('Explain and improve this selection.');
    }),
    vscode.commands.registerCommand('olkil.openWebsite', () => {
      void vscode.env.openExternal(vscode.Uri.parse('https://olkil.com'));
    }),
    vscode.commands.registerCommand('olkil.openDesktop', () => {
      void vscode.env.openExternal(vscode.Uri.parse('https://olkil.com/downloads/OLKIL-1.3.27.exe'));
    }),
    { dispose: () => provider.dispose() },
  );
}

export function deactivate() {}
