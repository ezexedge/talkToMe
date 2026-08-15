import { Global, Module } from '@nestjs/common';
import { RedisPubSubService } from '../signaling/redis-pubsub.service';
import { LocalSseRegistry } from '../signaling/local-sse-registry';

/**
 * Redis como módulo compartido.
 *
 * Nació dentro de SignalingModule porque la señalización era su único
 * consumidor, pero ahora también lo usa la caché de perfiles (UsersModule).
 * Dejarlo donde estaba habría creado un ciclo —users necesitaría signaling, y
 * signaling ya necesita users—, así que se extrae a su propio módulo: es
 * infraestructura, no lógica de señalización.
 *
 * `@Global` porque la conexión a Redis es un singleton de proceso (dos clientes
 * ioredis, pub y sub) y no tiene sentido re-importarlo en cada módulo.
 */
/**
 * `LocalSseRegistry` vive acá y no en SignalingModule porque el dispatch de los
 * mensajes que llegan de Redis los empuja a los Subjects SSE locales, o sea que
 * RedisPubSubService depende de él. Tiene que ser el MISMO singleton que usa el
 * controller: si cada módulo tuviera su instancia, el controller registraría al
 * cliente en un Map y Redis buscaría en otro, y nunca se entregaría nada.
 */
@Global()
@Module({
  providers: [RedisPubSubService, LocalSseRegistry],
  exports: [RedisPubSubService, LocalSseRegistry],
})
export class RedisModule {}
