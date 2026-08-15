import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import {
  IOlkilChatService,
  IOlkilChatUiService,
  IOlkilVirtualOfficeService,
  OlkilAiNodeServicePath,
} from '../common';
import { OlkilChatService } from './chat.service';
import { OlkilChatUiService } from './chat.ui.service';
import { OlkilChatHistoryService } from './chat-history.service';
import { OlkilAiContribution } from './olkil-ai.contribution';
import { OlkilVirtualOfficeService } from './virtual-office.service';
import {
  OlkilVirtualOfficeContribution,
  OlkilVirtualOfficeResourceProvider,
} from './virtual-office.contribution';

@Injectable()
export class OlkilAiModule extends BrowserModule {
  providers: Provider[] = [
    OlkilAiContribution,
    OlkilChatHistoryService,
    OlkilVirtualOfficeContribution,
    OlkilVirtualOfficeResourceProvider,
    {
      token: IOlkilChatService,
      useClass: OlkilChatService,
    },
    {
      token: IOlkilChatUiService,
      useClass: OlkilChatUiService,
    },
    {
      token: IOlkilVirtualOfficeService,
      useClass: OlkilVirtualOfficeService,
    },
  ];

  backServices = [
    {
      servicePath: OlkilAiNodeServicePath,
    },
  ];
}
