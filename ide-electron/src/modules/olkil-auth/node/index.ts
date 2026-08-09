import { Injectable, Provider } from '@opensumi/di';
import { NodeModule } from '@opensumi/ide-core-node';
import { IOlkilAuthNodeService, OlkilAuthNodeServicePath } from '../common';
import { OlkilAuthNodeService } from './auth-node.service';

@Injectable()
export class OlkilAuthNodeModule extends NodeModule {
  providers: Provider[] = [
    {
      token: IOlkilAuthNodeService,
      useClass: OlkilAuthNodeService,
    },
  ];

  backServices = [
    {
      token: IOlkilAuthNodeService,
      servicePath: OlkilAuthNodeServicePath,
    },
  ];
}
