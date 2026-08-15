import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';

/**
 * DatabaseModule — conexión TypeORM a Postgres (Neon).
 *
 * Sobre `ssl`: Neon SOLO acepta conexiones TLS (su connection string trae
 * `sslmode=require`). El driver `pg` no lee ese parámetro de la URL por sí
 * solo, así que hay que pasarle la opción explícitamente. `rejectUnauthorized:
 * false` es necesario porque el certificado lo firma la CA de Neon y no
 * empaquetamos su root cert; la conexión sigue estando cifrada.
 *
 * Sobre `synchronize`: crea/actualiza las tablas a partir de las entidades, sin
 * migraciones. Es cómodo para un MVP, pero puede DESTRUIR datos si una entidad
 * cambia, así que queda desactivado en producción — ahí van migraciones.
 */
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
        // Neon cierra las conexiones ociosas de su pooler; un pool chico y con
        // reciclado evita quedarnos con sockets muertos entre llamadas.
        extra: { max: 10, idleTimeoutMillis: 30_000 },
      }),
    }),
  ],
})
export class DatabaseModule {}
