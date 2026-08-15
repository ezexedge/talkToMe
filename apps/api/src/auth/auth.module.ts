import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Auth0ProfileService } from './auth0-profile.service';
import { JwtVerifierService } from './jwt-verifier.service';

/**
 * AuthModule — validación de los tokens de Auth0.
 *
 * No emite tokens ni guarda sesiones: eso lo hace Auth0. Acá solo se verifica
 * la firma contra el JWKS público y se sincroniza el usuario con Neon.
 *
 * `session: false` porque la autenticación viaja en cada request dentro del
 * token; no hay cookie de sesión que mantener. Eso deja al API sin estado y
 * permite correr varias instancias detrás de un balanceador sin sticky sessions
 * — el mismo criterio que llevó a poner la señalización en Redis.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    UsersModule,
  ],
  providers: [JwtStrategy, JwtAuthGuard, Auth0ProfileService, JwtVerifierService],
  exports: [JwtAuthGuard, PassportModule, JwtVerifierService],
})
export class AuthModule {}
