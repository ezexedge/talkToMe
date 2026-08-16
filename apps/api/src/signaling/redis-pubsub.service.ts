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

@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);

  private redisPub!: Redis;
  private redisSub!: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: LocalSseRegistry,
  ) {}

  get commands(): Redis {
    return this.redisPub;
  }

  onModuleInit(): void {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      throw new Error(
        'REDIS_URL no está definida (esquema rediss:// para Upstash)',
      );
    }

    this.redisPub = new Redis(url, { lazyConnect: false });
    this.redisSub = new Redis(url, { lazyConnect: false });

    this.redisPub.on('error', (e) =>
      this.logger.error(`redisPub: ${e.message}`),
    );
    this.redisSub.on('error', (e) =>
      this.logger.error(`redisSub: ${e.message}`),
    );

    this.redisSub.on('message', (channel, raw) => {
      this.dispatchToLocalClients(channel, raw);
    });

    this.logger.log('Redis Pub/Sub conectado (pub + sub)');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.redisPub?.quit(), this.redisSub?.quit()]);
  }

  async publish(roomId: string, message: SignalMessage): Promise<void> {
    this.logger.log(
      `[REDIS-PUB] 📨 PUBLICANDO en ${roomChannel(roomId)} | type=${message.type} from=${message.from}${message.to ? ` to=${message.to}` : ''}`,
    );
    await this.redisPub.publish(roomChannel(roomId), JSON.stringify(message));
  }

  async subscribe(roomId: string): Promise<void> {
    await this.redisSub.subscribe(roomChannel(roomId));
    this.logger.debug(`Suscrito a ${roomChannel(roomId)}`);
  }

  async unsubscribe(roomId: string): Promise<void> {
    await this.redisSub.unsubscribe(roomChannel(roomId));
    this.logger.debug(`Desuscrito de ${roomChannel(roomId)}`);
  }

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

    const roomId = channel.slice('room:'.length);

    this.logger.log(
      `[REDIS-SUB-01] 📬 Mensaje RECIBIDO de Redis en ${channel} | type=${message.type} from=${message.from} → busco a quién entregar LOCALMENTE`,
    );

    const members = await this.getRoomMembers(roomId);

    let entregados = 0;
    for (const clientId of members) {
      if (clientId === message.from) {
        this.logger.log(
          `[REDIS-SUB-02] ↩️ Salto a ${clientId}: es el EMISOR (from), no me devuelvo su propio mensaje`,
        );
        continue;
      }
      if (message.to && message.to !== clientId) continue;
      const subject = this.registry.getClient(clientId);
      if (subject) {
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
