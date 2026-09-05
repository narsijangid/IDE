import { Autowired } from '@opensumi/di';
import {
  ClientAppContribution,
  CommandService,
  Domain,
  PreferenceScope,
  PreferenceService,
  URI,
} from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';

/**
 * Keep file/git/search work inside the folder the user opened.
 *
 * vscode.git walks up with `git rev-parse --show-toplevel`, so opening
 * `repo/app` would otherwise watch/read the parent repo. Disable that walk-up
 * and only open Git when this folder itself contains `.git`.
 */
@Domain(ClientAppContribution)
export class OlkilWorkspaceScopeContribution implements ClientAppContribution {
  @Autowired(PreferenceService)
  private readonly prefs!: PreferenceService;

  @Autowired(IWorkspaceService)
  private readonly workspace!: IWorkspaceService;

  @Autowired(IFileServiceClient)
  private readonly files!: IFileServiceClient;

  @Autowired(CommandService)
  private readonly commands!: CommandService;

  async initialize() {
    await this.prefs.set('git.autoRepositoryDetection', false, PreferenceScope.Default);
  }

  onDidStart() {
    const onChanged = this.workspace.onWorkspaceChanged;
    if (typeof onChanged === 'function') {
      onChanged.call(this.workspace, () => void this.syncGitToOpenedFolders());
    }
    window.setTimeout(() => void this.syncGitToOpenedFolders(), 900);
    window.setTimeout(() => void this.syncGitToOpenedFolders(), 4000);
  }

  private async syncGitToOpenedFolders() {
    const roots = this.workspace.tryGetRoots?.() || [];
    for (const root of roots) {
      const folder = new URI(root.uri).codeUri.fsPath;
      if (!folder) {
        continue;
      }
      const gitUri = new URI(root.uri).resolve('.git');
      try {
        const hasGit = await this.files.access(gitUri.toString());
        if (hasGit) {
          await this.commands.executeCommand('git.openRepository', new URI(root.uri).codeUri.fsPath);
        }
      } catch {
        // Git extension may not be ready; the next workspace event retries.
      }
    }
  }
}
