import { Global, Module } from '@nestjs/common';
import { RedisPubSubService } from '../signaling/redis-pubsub.service';
import { LocalSseRegistry } from '../signaling/local-sse-registry';

@Global()
@Module({
  providers: [RedisPubSubService, LocalSseRegistry],
  exports: [RedisPubSubService, LocalSseRegistry],
})
export class RedisModule {}
