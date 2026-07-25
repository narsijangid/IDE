import { Injectable, Provider } from '@opensumi/di';
import { NodeModule } from '@opensumi/ide-core-node';
import { IOlkilAiNodeService, OlkilAiNodeServicePath } from '../common';
import { OlkilAiNodeService } from './llm.service';

@Injectable()
export class OlkilAiNodeModule extends NodeModule {
  providers: Provider[] = [
    {
      token: IOlkilAiNodeService,
      useClass: OlkilAiNodeService,
    },
  ];

  backServices = [
    {
      token: IOlkilAiNodeService,
      servicePath: OlkilAiNodeServicePath,
    },
  ];
}
