import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
// El index del paquete NO re-exporta este tipo; hay que traerlo de su archivo.
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisPubSubService } from '../signaling/redis-pubsub.service';

/**
 * Storage del rate limiter en Redis, COMPARTIDO entre réplicas.
 *
 * El storage por defecto de @nestjs/throttler guarda los contadores en la RAM
 * del proceso. Con una sola instancia funciona, pero acá corren api1 y api2
 * detrás de Caddy con `lb_policy least_conn`, así que cada réplica llevaba su
 * propia cuenta: el límite efectivo era de entre 1x y 2x el configurado según
 * a qué réplica cayera cada request, y con SSE el reparto es todavía más
 * despareja (los POST de una misma negociación se dividen entre las dos).
 *
 * Se reusa la conexión `redisPub` que ya existe (RedisPubSubService.commands)
 * en vez de abrir una tercera: son comandos normales, no Pub/Sub, así que la
 * restricción de "una conexión en modo subscribe no puede ejecutar otros
 * comandos" no aplica acá.
 *
 * No se agregó ninguna dependencia nueva: esto implementa la interfaz
 * `ThrottlerStorage` de @nestjs/throttler directamente.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisPubSubService) {}

  /**
   * Un `INCR` + `PEXPIRE` en una sola ida a Redis (pipeline), más el manejo del
   * bloqueo que espera la interfaz.
   *
   * El TTL se fija SOLO cuando el contador vale 1 (la primera petición de la
   * ventana). Si se renovara en cada hit, la ventana nunca vencería para quien
   * sigue mandando tráfico y el bloqueo sería permanente.
   *
   * Si Redis falla, se DEJA PASAR la request (fail-open). Un rate limiter caído
   * no puede convertirse en una caída del servicio: es preferible no limitar
   * durante unos segundos que rechazar todas las llamadas en curso.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:${throttlerName}:${key}:blocked`;

    try {
      const client = this.redis.commands;

      // ¿Ya está bloqueado por haber excedido el límite antes?
      const blockTtl = await client.pttl(blockKey);
      if (blockTtl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(blockTtl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockTtl / 1000),
        };
      }

      const [incrResult, pttlResult] = await client
        .multi()
        .incr(hitsKey)
        .pttl(hitsKey)
        .exec();

      const totalHits = Number(incrResult?.[1] ?? 0);
      let remainingMs = Number(pttlResult?.[1] ?? -1);

      // Primer hit de la ventana (o clave sin TTL por algún motivo): se le pone
      // el vencimiento. Ver el comentario de arriba sobre por qué NO se renueva
      // en cada petición.
      if (totalHits === 1 || remainingMs < 0) {
        await client.pexpire(hitsKey, ttl);
        remainingMs = ttl;
      }

      if (totalHits > limit) {
        // Se pasó: se marca el bloqueo y se limpia el contador, así al vencer
        // el bloqueo la ventana arranca de cero.
        await client.set(blockKey, '1', 'PX', blockDuration);
        await client.del(hitsKey);

        return {
          totalHits,
          timeToExpire: Math.ceil(blockDuration / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockDuration / 1000),
        };
      }

      return {
        totalHits,
        timeToExpire: Math.ceil(remainingMs / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (e) {
      // Fail-open, a propósito: ver el comentario del método.
      this.logger.error(
        `Redis caído al contar rate limit (${hitsKey}): ${
          e instanceof Error ? e.message : String(e)
        }. Se DEJA PASAR la request.`,
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
