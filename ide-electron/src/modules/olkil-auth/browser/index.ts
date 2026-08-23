import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { IOlkilAuthService, IOlkilSettingsService, OlkilAuthNodeServicePath } from '../common';
import { OlkilAuthService } from './auth.service';
import { OlkilSettingsService } from './settings.service';
import {
  OlkilAccountResourceProvider,
  OlkilAuthContribution,
} from './olkil-auth.contribution';

@Injectable()
export class OlkilAuthModule extends BrowserModule {
  providers: Provider[] = [
    OlkilAuthContribution,
    OlkilAccountResourceProvider,
    {
      token: IOlkilAuthService,
      useClass: OlkilAuthService,
    },
    {
      token: IOlkilSettingsService,
      useClass: OlkilSettingsService,
    },
  ];

  backServices = [
    {
      servicePath: OlkilAuthNodeServicePath,
    },
  ];
}
