import { Injectable, Logger } from '@nestjs/common';
import { RedisPubSubService } from '../signaling/redis-pubsub.service';
import { UsersService } from './users.service';

/** Perfil mínimo para pintar un avatar en el lobby. */
export interface PublicProfile {
  sub: string;
  name: string | null;
  picture: string | null;
}

export const userProfileKey = (sub: string): string => `user:${sub}:profile`;

/**
 * Caché de perfiles en Redis, con Postgres como respaldo.
 *
 * POR QUÉ: el lobby muestra el avatar de quienes están en cada sala y se
 * refresca cada 10s en cada pestaña abierta. Resolver eso contra Neon sería un
 * SELECT por usuario y por refresco; en Redis es un HGETALL sobre datos que ya
 * están en memoria, y encima Redis ya es parte del camino caliente (la
 * membresía de rooms vive ahí).
 *
 * Postgres sigue siendo la FUENTE DE VERDAD: Redis es solo una copia con TTL.
 * Si el dato no está cacheado, se lee de la base y se re-cachea. Perder la
 * caché no pierde información.
 */
@Injectable()
export class UserCacheService {
  private readonly logger = new Logger(UserCacheService.name);

  /**
   * TTL de 1h: bastante para que un usuario activo no golpee Postgres, y
   * suficientemente corto para que un cambio de foto o nombre se refleje solo.
   */
  private static readonly TTL_SECONDS = 3600;

  constructor(
    private readonly redis: RedisPubSubService,
    private readonly users: UsersService,
  ) {}

  /** Guarda el perfil en Redis. Se llama tras cada upsert. */
  async cache(profile: PublicProfile): Promise<void> {
    const key = userProfileKey(profile.sub);
    await this.redis.commands.hset(key, {
      name: profile.name ?? '',
      picture: profile.picture ?? '',
    });
    await this.redis.commands.expire(key, UserCacheService.TTL_SECONDS);
  }

  /**
   * Resuelve varios perfiles a la vez (los miembros de las salas del lobby).
   *
   * Se hace en dos pasos para no castigar la latencia: primero un pipeline con
   * TODOS los HGETALL de una (un solo round-trip a Redis en vez de N), y recién
   * para los que faltan se va a Postgres. En el caso normal —usuarios activos,
   * ya cacheados— Postgres no se toca.
   */
  async getMany(subs: string[]): Promise<Map<string, PublicProfile>> {
    const result = new Map<string, PublicProfile>();
    if (subs.length === 0) return result;

    const unique = [...new Set(subs)];

    const pipeline = this.redis.commands.pipeline();
    unique.forEach((sub) => pipeline.hgetall(userProfileKey(sub)));
    const replies = await pipeline.exec();

    const misses: string[] = [];
    unique.forEach((sub, i) => {
      const [err, data] = replies?.[i] ?? [null, null];
      const hash = data as Record<string, string> | null;
      // Un hash inexistente vuelve como objeto vacío, no como null.
      if (!err && hash && Object.keys(hash).length > 0) {
        result.set(sub, {
          sub,
          name: hash.name || null,
          picture: hash.picture || null,
        });
      } else {
        misses.push(sub);
      }
    });

    if (misses.length > 0) {
      this.logger.log(
        `[CACHE] ${unique.length - misses.length} perfiles desde Redis, ${misses.length} desde Postgres`,
      );
      // Fallback a la fuente de verdad, y re-cacheo para el próximo refresco.
      await Promise.all(
        misses.map(async (sub) => {
          const user = await this.users.findByAuth0Id(sub);
          if (!user) return;
          const profile: PublicProfile = {
            sub,
            name: user.name,
            picture: user.picture,
          };
          result.set(sub, profile);
          await this.cache(profile);
        }),
      );
    }

    return result;
  }
}
