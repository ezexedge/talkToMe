import { Injectable, Logger } from '@nestjs/common';
import { RedisPubSubService } from '../signaling/redis-pubsub.service';
import { UsersService } from './users.service';

export interface PublicProfile {
  sub: string;
  name: string | null;
  picture: string | null;
}

export const userProfileKey = (sub: string): string => `user:${sub}:profile`;

@Injectable()
export class UserCacheService {
  private readonly logger = new Logger(UserCacheService.name);

  private static readonly TTL_SECONDS = 3600;

  constructor(
    private readonly redis: RedisPubSubService,
    private readonly users: UsersService,
  ) {}

  async cache(profile: PublicProfile): Promise<void> {
    const key = userProfileKey(profile.sub);
    await this.redis.commands.hset(key, {
      name: profile.name ?? '',
      picture: profile.picture ?? '',
    });
    await this.redis.commands.expire(key, UserCacheService.TTL_SECONDS);
  }

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
