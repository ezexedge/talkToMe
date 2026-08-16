import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Auth0ProfileService } from './auth0-profile.service';
import { JwtVerifierService } from './jwt-verifier.service';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    UsersModule,
  ],
  providers: [
    JwtStrategy,
    JwtAuthGuard,
    Auth0ProfileService,
    JwtVerifierService,
  ],
  exports: [JwtAuthGuard, PassportModule, JwtVerifierService],
})
export class AuthModule {}
