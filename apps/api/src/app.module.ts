import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SignalingModule } from './signaling/signaling.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { RedisThrottlerStorage } from './auth/redis-throttler.storage';
import { RedisPubSubService } from './signaling/redis-pubsub.service';
import { UsersModule } from './users/users.module';

/**
 * Límites de rate limiting, todos POR USUARIO y POR MINUTO (ttl en ms).
 *
 * Salen del tráfico real de una llamada, no de un número redondo:
 *
 *   - ICE: `pc.onicecandidate` dispara un POST por candidato. Una negociación
 *     genera entre 10 y 30 en una ráfaga de ~5s, y más en móvil (wifi + datos
 *     + IPv6). Como cada F5 renegocia desde cero, 200/min cubre varias
 *     reconexiones seguidas sin tocar nunca a un usuario real.
 *
 *   - SDP: exactamente 2 por negociación (offer + answer). 20/min = 10
 *     renegociaciones, de sobra.
 *
 *   - ROOMS: crear room es la operación cara y además ya tiene TTL de 120s.
 *
 *   - LIST: el GET de rooms, que el front POLLEA cada 10s además de refrescar
 *     en focus/visibilitychange/pageshow. Tiene cupo propio a propósito: con el
 *     límite `default` compartido, ese goteo constante agotaba el cupo y hacía
 *     caer endpoints críticos que también usan `default`, como `leave`.
 *
 *   - ACTIONS: mute/kick/leave los dispara una persona haciendo clic.
 *
 * IMPORTANTE: son estimaciones con margen (~10x lo esperado), NO valores
 * medidos. UserThrottlerGuard loguea cada 429 justamente para poder ajustarlos
 * con datos reales. Un límite que corta a un usuario legítimo es peor que uno
 * que solo atrapa loops descontrolados.
 */
const MINUTE = 60_000;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRootAsync({
      // El storage va en Redis (RedisThrottlerStorage), no en memoria: con dos
      // réplicas detrás de Caddy cada proceso llevaba su propio contador y el
      // límite real quedaba entre 1x y 2x el configurado.
      imports: [RedisModule],
      inject: [RedisPubSubService],
      useFactory: (redis: RedisPubSubService) => ({
        throttlers: [
          { name: 'default', ttl: MINUTE, limit: 100 },
          { name: 'ice', ttl: MINUTE, limit: 200 },
          { name: 'sdp', ttl: MINUTE, limit: 20 },
          { name: 'rooms', ttl: MINUTE, limit: 5 },
          { name: 'list', ttl: MINUTE, limit: 120 },
          { name: 'actions', ttl: MINUTE, limit: 30 },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    DatabaseModule,
    RedisModule,
    AuthModule,
    UsersModule,
    SignalingModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global: cada endpoint queda cubierto por el límite `default` salvo que
    // declare el suyo con @Throttle(). Así un endpoint nuevo nace protegido en
    // vez de quedar abierto por olvido.
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
