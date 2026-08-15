import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface Auth0Profile {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

@Injectable()
export class Auth0ProfileService {
  private readonly logger = new Logger(Auth0ProfileService.name);
  private readonly domain: string;

  private readonly cache = new Map<string, { profile: Auth0Profile; at: number }>();

  private static readonly TTL_MS = 60 * 60 * 1000;

  constructor(config: ConfigService) {
    this.domain = config.get<string>('AUTH0_DOMAIN') ?? '';
  }

  async fetchProfile(
    sub: string,
    accessToken: string,
  ): Promise<Auth0Profile | null> {
    const hit = this.cache.get(sub);
    if (hit && Date.now() - hit.at < Auth0ProfileService.TTL_MS) {
      return hit.profile;
    }

    try {
      const res = await fetch(`https://${this.domain}/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        this.logger.warn(
          `[PROFILE] /userinfo respondió ${res.status} para sub=${sub}; sigo sin perfil`,
        );
        return null;
      }

      const profile = (await res.json()) as Auth0Profile;
      this.cache.set(sub, { profile, at: Date.now() });
      this.logger.log(
        `[PROFILE] 👤 Perfil traído de Auth0 | sub=${sub} email=${profile.email ?? '(sin email)'}`,
      );
      return profile;
    } catch (e) {
      this.logger.warn(
        `[PROFILE] Falló /userinfo para sub=${sub}: ${(e as Error).message}`,
      );
      return null;
    }
  }
}
