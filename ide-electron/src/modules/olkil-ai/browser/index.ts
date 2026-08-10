import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { IOlkilChatService, IOlkilChatUiService, OlkilAiNodeServicePath } from '../common';
import { OlkilChatService } from './chat.service';
import { OlkilChatUiService } from './chat.ui.service';
import { OlkilChatHistoryService } from './chat-history.service';
import { OlkilAiContribution } from './olkil-ai.contribution';

@Injectable()
export class OlkilAiModule extends BrowserModule {
  providers: Provider[] = [
    OlkilAiContribution,
    OlkilChatHistoryService,
    {
      token: IOlkilChatService,
      useClass: OlkilChatService,
    },
    {
      token: IOlkilChatUiService,
      useClass: OlkilChatUiService,
    },
  ];

  backServices = [
    {
      servicePath: OlkilAiNodeServicePath,
    },
  ];
}
