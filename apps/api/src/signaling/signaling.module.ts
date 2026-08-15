import { Module } from '@nestjs/common';
import { SignalingController } from './signaling.controller';
import { RoomsService } from './rooms.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [SignalingController],
  providers: [RoomsService],
})
export class SignalingModule {}
