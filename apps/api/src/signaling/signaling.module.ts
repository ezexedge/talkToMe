import { Module } from '@nestjs/common';
import { SignalingController } from './signaling.controller';
import { RoomsService } from './rooms.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  // AuthModule aporta el JwtAuthGuard que protege toda la señalización.
  // UsersModule aporta la caché de perfiles para pintar avatares en el lobby.
  imports: [AuthModule, UsersModule],
  controllers: [SignalingController],
  // LocalSseRegistry y RedisPubSubService vienen del RedisModule global
  // (son un único singleton compartido con el dispatch de Pub/Sub).
  providers: [RoomsService],
})
export class SignalingModule {}
