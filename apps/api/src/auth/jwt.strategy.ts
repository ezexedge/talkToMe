import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { Request } from 'express';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { Auth0ProfileService } from './auth0-profile.service';
import { UserCacheService } from '../users/user-cache.service';

interface Auth0Payload {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

// EventSource can't send headers, so the SSE endpoint takes the token by query.
const fromQueryToken = (req: Request): string | null => {
  const token = req?.query?.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    private readonly profiles: Auth0ProfileService,
    private readonly userCache: UserCacheService,
  ) {
    const domain = config.get<string>('AUTH0_DOMAIN');
    const audience = config.get<string>('AUTH0_AUDIENCE');
    const issuer =
      config.get<string>('AUTH0_ISSUER_URL') ?? `https://${domain}/`;

    super({
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `https://${domain}/.well-known/jwks.json`,
      }),
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromQueryToken,
      ]),
      audience,
      issuer,
      algorithms: ['RS256'],
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: Auth0Payload): Promise<User> {
    if (!payload?.sub) {
      throw new UnauthorizedException('Token sin `sub`');
    }

    const ns = 'https://my-turborepo/';
    let claims = {
      sub: payload.sub,
      email: (payload[`${ns}email`] as string) ?? payload.email,
      name: (payload[`${ns}name`] as string) ?? payload.name,
      givenName: payload[`${ns}given_name`] as string | undefined,
      familyName: payload[`${ns}family_name`] as string | undefined,
      picture: (payload[`${ns}picture`] as string) ?? payload.picture,
    };

    if (!claims.email && !claims.name) {
      const token = this.extractToken(req);
      if (token) {
        const profile = await this.profiles.fetchProfile(payload.sub, token);
        if (profile) {
          claims = {
            sub: payload.sub,
            email: profile.email,
            name: profile.name,
            givenName: profile.given_name,
            familyName: profile.family_name,
            picture: profile.picture,
          };
        }
      }
    }

    const user = await this.users.upsertFromAuth0(claims);

    await this.userCache
      .cache({ sub: user.auth0Id, name: user.name, picture: user.picture })
      .catch(() => undefined);

    return user;
  }

  private extractToken(req: Request): string | null {
    const header = req.headers?.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
    const q = req.query?.token;
    return typeof q === 'string' && q.length > 0 ? q : null;
  }
}
