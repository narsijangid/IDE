import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { IOlkilAuthService, OlkilAuthNodeServicePath } from '../common';
import { OlkilAuthService } from './auth.service';
import { OlkilAuthContribution } from './olkil-auth.contribution';

@Injectable()
export class OlkilAuthModule extends BrowserModule {
  providers: Provider[] = [
    OlkilAuthContribution,
    {
      token: IOlkilAuthService,
      useClass: OlkilAuthService,
    },
  ];

  backServices = [
    {
      servicePath: OlkilAuthNodeServicePath,
    },
  ];
}
