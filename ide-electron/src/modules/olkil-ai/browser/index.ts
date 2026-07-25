import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { IOlkilChatService, OlkilAiNodeServicePath } from '../common';
import { OlkilChatService } from './chat.service';
import { OlkilAiContribution } from './olkil-ai.contribution';

@Injectable()
export class OlkilAiModule extends BrowserModule {
  providers: Provider[] = [
    OlkilAiContribution,
    {
      token: IOlkilChatService,
      useClass: OlkilChatService,
    },
  ];

  backServices = [
    {
      servicePath: OlkilAiNodeServicePath,
    },
  ];
}
