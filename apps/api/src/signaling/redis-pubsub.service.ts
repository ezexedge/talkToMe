import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { LocalSseRegistry } from './local-sse-registry';
import { SignalMessage, roomChannel, roomMembersKey } from './types';

/**
 * RedisPubSubService — encapsula TODA la mecánica de Pub/Sub con ioredis.
 * Si mañana cambiamos de backend, solo se toca este archivo.
 *
 * ¿Por qué DOS clientes ioredis?
 * Una conexión Redis que entra en modo "subscribe" queda bloqueada: no puede
 * ejecutar otros comandos (SADD, PUBLISH, etc.). Por eso necesitamos:
 *   - redisPub: para PUBLISH y para los comandos del SET (lo expone como `commands`).
 *   - redisSub: dedicado exclusivamente a SUBSCRIBE/UNSUBSCRIBE y a recibir mensajes.
 *
 * Upstash requiere TLS, por eso REDIS_URL usa el esquema `rediss://`.
 */
@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);

  private redisPub!: Redis;
  private redisSub!: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: LocalSseRegistry,
  ) {}

  /** Cliente para PUBLISH y comandos (SADD/SREM/SCARD/…). */
  get commands(): Redis {
    return this.redisPub;
  }

  onModuleInit(): void {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      throw new Error('REDIS_URL no está definida (esquema rediss:// para Upstash)');
    }

    this.redisPub = new Redis(url, { lazyConnect: false });
    this.redisSub = new Redis(url, { lazyConnect: false });

    this.redisPub.on('error', (e) => this.logger.error(`redisPub: ${e.message}`));
    this.redisSub.on('error', (e) => this.logger.error(`redisSub: ${e.message}`));

    // Único handler de mensajes entrantes del canal: despacha a los SSE locales.
    this.redisSub.on('message', (channel, raw) => {
      this.dispatchToLocalClients(channel, raw);
    });

    this.logger.log('Redis Pub/Sub conectado (pub + sub)');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.redisPub?.quit(), this.redisSub?.quit()]);
  }

  /** Publica un mensaje en el canal de la room. */
  async publish(roomId: string, message: SignalMessage): Promise<void> {
    this.logger.log(
      `[REDIS-PUB] 📨 PUBLICANDO en ${roomChannel(roomId)} | type=${message.type} from=${message.from}${message.to ? ` to=${message.to}` : ''}`,
    );
    await this.redisPub.publish(roomChannel(roomId), JSON.stringify(message));
  }

  /** Suscribe ESTA instancia al canal de la room (idempotente desde el caller). */
  async subscribe(roomId: string): Promise<void> {
    await this.redisSub.subscribe(roomChannel(roomId));
    this.logger.debug(`Suscrito a ${roomChannel(roomId)}`);
  }

  /** Desuscribe ESTA instancia del canal de la room. */
  async unsubscribe(roomId: string): Promise<void> {
    await this.redisSub.unsubscribe(roomChannel(roomId));
    this.logger.debug(`Desuscrito de ${roomChannel(roomId)}`);
  }

  /**
   * Recibe un mensaje crudo de Redis y lo entrega SOLO a los clientes que:
   *   1. están conectados LOCALMENTE en esta instancia (están en el Map), y
   *   2. son miembros de esa room en Redis, y
   *   3. NO son el emisor (`from`) — Pub/Sub hizo broadcast incluido el emisor.
   *
   * Para `to` definido, además se filtra al destinatario concreto.
   */
  private async dispatchToLocalClients(
    channel: string,
    raw: string,
  ): Promise<void> {
    let message: SignalMessage;
    try {
      message = JSON.parse(raw) as SignalMessage;
    } catch {
      this.logger.warn(`[REDIS-SUB] ⚠️ Mensaje no parseable en ${channel}`);
      return;
    }

    // channel = "room:{roomId}"
    const roomId = channel.slice('room:'.length);

    this.logger.log(
      `[REDIS-SUB-01] 📬 Mensaje RECIBIDO de Redis en ${channel} | type=${message.type} from=${message.from} → busco a quién entregar LOCALMENTE`,
    );

    // Miembros de la room según Redis (fuente de verdad de la membresía).
    const members = await this.getRoomMembers(roomId);

    let entregados = 0;
    for (const clientId of members) {
      if (clientId === message.from) {
        this.logger.log(
          `[REDIS-SUB-02] ↩️ Salto a ${clientId}: es el EMISOR (from), no me devuelvo su propio mensaje`,
        );
        continue; // no devolver al emisor
      }
      if (message.to && message.to !== clientId) continue; // dirigido a otro
      const subject = this.registry.getClient(clientId);
      if (subject) {
        // Está conectado en ESTA instancia → empujar por su SSE.
        this.logger.log(
          `[REDIS-SUB-03] 📲 ${clientId} está LOCAL en esta instancia → empujo '${message.type}' por su SSE`,
        );
        subject.next({ data: message });
        entregados++;
      } else {
        this.logger.log(
          `[REDIS-SUB-04] 🌐 ${clientId} NO está local en esta instancia (estará en otra) → no hago nada acá`,
        );
      }
    }
    this.logger.log(
      `[REDIS-SUB-05] ✔️ Despacho terminado para type=${message.type} | entregados localmente: ${entregados}`,
    );
  }

  private async getRoomMembers(roomId: string): Promise<string[]> {
    return this.commands.smembers(roomMembersKey(roomId));
  }
}
