import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserCacheService } from './user-cache.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService, UserCacheService],
  // Lo exporta porque AuthModule lo necesita: la JwtStrategy hace el upsert.
  exports: [UsersService, UserCacheService],
})
export class UsersModule {}
