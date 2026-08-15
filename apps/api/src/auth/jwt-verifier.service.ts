import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

/**
 * Verifica tokens de Auth0 fuera del pipeline de guards.
 *
 * El `JwtAuthGuard` sirve para "esta ruta requiere sesión". Este servicio es
 * para el caso distinto de "esta ruta es pública, pero muestra MÁS si hay
 * sesión" — como el lobby, que lista las salas para cualquiera pero solo revela
 * quién está adentro a usuarios logueados.
 *
 * Usa el mismo JWKS y las mismas validaciones (audience, issuer, RS256) que la
 * JwtStrategy: la diferencia es qué se hace ante un token inválido — el guard
 * responde 401, acá simplemente se muestra menos.
 */
@Injectable()
export class JwtVerifierService {
  private readonly jwks: JwksClient;
  private readonly audience: string;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    const domain = config.get<string>('AUTH0_DOMAIN');
    this.audience = config.get<string>('AUTH0_AUDIENCE') ?? '';
    this.issuer =
      config.get<string>('AUTH0_ISSUER_URL') ?? `https://${domain}/`;
    this.jwks = new JwksClient({
      jwksUri: `https://${domain}/.well-known/jwks.json`,
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
    });
  }

  /** Resuelve con el payload si el token es válido; lanza si no. */
  async verify(token: string): Promise<jwt.JwtPayload> {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        (header, callback) => {
          this.jwks
            .getSigningKey(header.kid)
            .then((key) => callback(null, key.getPublicKey()))
            .catch((err) => callback(err as Error));
        },
        {
          audience: this.audience,
          issuer: this.issuer,
          algorithms: ['RS256'],
        },
        (err, decoded) => {
          if (err || !decoded) return reject(err ?? new Error('Token inválido'));
          resolve(decoded as jwt.JwtPayload);
        },
      );
    });
  }
}
