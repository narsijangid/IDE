import { Injectable } from '@opensumi/di';
import { createElectronMainApi } from '@opensumi/ide-core-browser';
import { ElectronBasicModule } from '@opensumi/ide-electron-basic/lib/browser';
import { IMainStorageService } from 'common/types';
import { LocalMenuContribution } from './menu.contribution';
import { LocalThemeContribution } from './theme.contribution';
import { OlkilBrandingContribution } from './olkil-branding.contribution';
import { OlkilFileMenuContribution } from './olkil-file-menu.contribution';
import { OlkilTerminalContribution } from './terminal.contribution';
import { OlkilWorkspaceScopeContribution } from './olkil-workspace-scope.contribution';

@Injectable()
export class LocalBasicModule extends ElectronBasicModule {
  providers = [
    LocalMenuContribution,
    LocalThemeContribution,
    OlkilBrandingContribution,
    OlkilFileMenuContribution,
    OlkilTerminalContribution,
    OlkilWorkspaceScopeContribution,
    {
      token: IMainStorageService,
      useValue: createElectronMainApi(IMainStorageService),
    },
  ];
}
