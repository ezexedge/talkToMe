import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

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
          if (err || !decoded)
            return reject(err ?? new Error('Token inválido'));
          resolve(decoded as jwt.JwtPayload);
        },
      );
    });
  }
}
