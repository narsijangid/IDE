import { Autowired } from '@opensumi/di';
import {
  ClientAppContribution,
  Domain,
  PreferenceService,
  PreferenceScope,
} from '@opensumi/ide-core-browser';

/**
 * Ensure Windows PowerShell starts with -NoLogo.
 *
 * Upstream OpenSumi resolves `terminal.integrated.defaultProfile.windows` incorrectly
 * (async platform key used as a sync string), so the default shell often launches with
 * empty args and prints the copyright banner. Forcing `terminal.type` + shellArgs fixes it.
 */
@Domain(ClientAppContribution)
export class OlkilTerminalContribution implements ClientAppContribution {
  @Autowired(PreferenceService)
  private readonly preferenceService: PreferenceService;

  async initialize() {
    await Promise.all([
      this.preferenceService.set('terminal.type', 'powershell', PreferenceScope.Default),
      this.preferenceService.set(
        'terminal.integrated.shellArgs.windows',
        ['-NoLogo'],
        PreferenceScope.Default,
      ),
      this.preferenceService.set(
        'terminal.integrated.defaultProfile.windows',
        'Windows PowerShell',
        PreferenceScope.Default,
      ),
    ]);
  }
}
