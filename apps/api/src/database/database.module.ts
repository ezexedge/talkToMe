import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [User],
        synchronize: config.get<string>('NODE_ENV') !== 'production',
        ssl: { rejectUnauthorized: false },
        extra: { max: 10, idleTimeoutMillis: 30_000 },
      }),
    }),
  ],
})
export class DatabaseModule {}
