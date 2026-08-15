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

/** Claims que Auth0 mete en el access token una vez verificado. */
interface Auth0Payload {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  /** Claims de perfil bajo namespace, si se configuró una Action en Auth0. */
  [key: string]: unknown;
}

/**
 * Extrae el token de `?token=` en el query string.
 *
 * Existe SOLO por el SSE: `EventSource` no permite mandar cabeceras, así que un
 * `Authorization: Bearer` es imposible en `GET /signaling/stream`. Poner el
 * token en la URL tiene un costo real (queda en logs de acceso del server y en
 * el historial del navegador), y se mitiga con tokens de vida corta.
 *
 * Los demás endpoints usan el header y no pasan por acá.
 */
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
      /**
       * NO hay secreto compartido. Auth0 firma con RS256 (clave privada suya) y
       * nosotros verificamos con su clave pública, que se baja del JWKS.
       * `jwks-rsa` la cachea y limita el rate, así que no golpea a Auth0 en
       * cada request; cuando Auth0 rota sus claves, la nueva se busca por el
       * `kid` del token.
       *
       * Consecuencia práctica: el API no guarda ningún secreto de Auth0 y
       * cualquier instancia puede validar por su cuenta — sin estado
       * compartido, igual que la señalización con Redis.
       */
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `https://${domain}/.well-known/jwks.json`,
      }),
      // El SSE manda el token por query; el resto por header.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromQueryToken,
      ]),
      /**
       * `audience` e `issuer` NO son opcionales: sin ellos aceptaríamos
       * cualquier token bien firmado por este tenant de Auth0 — incluido uno
       * emitido para OTRA API. Verificarlos ata el token a esta API.
       */
      audience,
      issuer,
      algorithms: ['RS256'],
      // Necesitamos el request en validate() para recuperar el token crudo y
      // poder presentarlo a /userinfo (ver abajo).
      passReqToCallback: true,
    });
  }

  /**
   * Corre DESPUÉS de que la firma, el issuer, la audience y la expiración ya
   * fueron verificados. Lo que llega acá es confiable.
   *
   * Acá se hace el upsert en Neon: es el único punto por el que pasa todo
   * usuario autenticado, así que garantiza que quien está logueado existe en
   * nuestra DB sin necesidad de un endpoint de registro.
   *
   * Lo que devuelve queda en `req.user`.
   */
  async validate(req: Request, payload: Auth0Payload): Promise<User> {
    if (!payload?.sub) {
      throw new UnauthorizedException('Token sin `sub`');
    }

    // (1) Claims del propio token. Un ACCESS token de Auth0 normalmente NO trae
    // email/name/picture (viven en el ID token), pero SÍ los trae si se
    // configuró una Action en Auth0 que los agregue bajo un namespace propio
    // (ver README). Ese es el camino barato: no cuesta ninguna llamada de red.
    const ns = 'https://my-turborepo/';
    let claims = {
      sub: payload.sub,
      email: (payload[`${ns}email`] as string) ?? payload.email,
      name: (payload[`${ns}name`] as string) ?? payload.name,
      givenName: payload[`${ns}given_name`] as string | undefined,
      familyName: payload[`${ns}family_name`] as string | undefined,
      picture: (payload[`${ns}picture`] as string) ?? payload.picture,
    };

    // (2) Si el token no trajo el perfil, se lo pedimos a /userinfo de Auth0
    // presentando este mismo token. Así el dato es VERIFICADO (viene de Auth0,
    // no del cliente) y no hace falta configurar nada en el dashboard.
    //
    // Va cacheado por usuario dentro del Auth0ProfileService, así que esto
    // dispara una llamada por usuario y no una por request.
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

    // Refrescar la caché de Redis con el perfil recién sincronizado. Así el
    // lobby puede pintar avatares sin tocar Postgres. Es best-effort: si Redis
    // falla, el lobby cae al fallback contra la base.
    await this.userCache
      .cache({ sub: user.auth0Id, name: user.name, picture: user.picture })
      .catch(() => undefined);

    return user;
  }

  /**
   * Recupera el token crudo del request, mirando en los mismos dos lugares que
   * los extractores de arriba: el header (POST) y el query (SSE y sendBeacon).
   */
  private extractToken(req: Request): string | null {
    const header = req.headers?.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
    const q = req.query?.token;
    return typeof q === 'string' && q.length > 0 ? q : null;
  }
}
