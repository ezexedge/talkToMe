import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Perfil que devuelve el endpoint /userinfo de Auth0 (claims OIDC estándar). */
export interface Auth0Profile {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

/**
 * Trae el perfil del usuario desde el endpoint `/userinfo` de Auth0.
 *
 * POR QUÉ HACE FALTA: el access token que llega al API NO trae email ni nombre.
 * Eso es diseño de OAuth2 — el perfil viaja en el ID token, que se queda en el
 * navegador. El access token dice qué podés hacer, no quién sos (más allá del
 * `sub`).
 *
 * Se prefiere esto a que el front mande el perfil en el body porque acá el dato
 * es VERIFICADO: se lo pedimos a Auth0 presentando el token del propio usuario.
 * Si confiáramos en el body, cualquiera podría registrar el email de otro.
 *
 * La alternativa sin llamada HTTP es una Action en Auth0 que agregue los claims
 * al access token (está documentada en el README). Si esos claims aparecen, la
 * JwtStrategy los usa y NO llama acá.
 */
@Injectable()
export class Auth0ProfileService {
  private readonly logger = new Logger(Auth0ProfileService.name);
  private readonly domain: string;

  /**
   * Caché en memoria de perfiles ya consultados.
   *
   * `validate()` corre en CADA request autenticado, así que sin caché haríamos
   * una llamada a Auth0 por request — lento y contra el rate limit. Con esto se
   * consulta una vez por usuario y por proceso.
   *
   * Es estado en RAM local y está bien que lo sea: es solo caché, no una fuente
   * de verdad. Si el proceso muere o hay varias instancias, cada una vuelve a
   * consultar y llega al mismo resultado. No confundir con la membresía de
   * rooms, que sí debe ser compartida y vive en Redis.
   */
  private readonly cache = new Map<string, { profile: Auth0Profile; at: number }>();

  /** Vida de la caché: 1h. Si alguien cambia su foto en Google, se refleja ahí. */
  private static readonly TTL_MS = 60 * 60 * 1000;

  constructor(config: ConfigService) {
    this.domain = config.get<string>('AUTH0_DOMAIN') ?? '';
  }

  /**
   * Devuelve el perfil, o null si Auth0 no lo da.
   *
   * Nunca lanza: si esta llamada falla, el usuario igual tiene que poder usar la
   * app (ya está autenticado, que es lo que importa). El perfil es un extra, y
   * se reintenta en el próximo request porque un fallo no se cachea.
   */
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
