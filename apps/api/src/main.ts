import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { LocalSseRegistry } from './signaling/local-sse-registry';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const configured = (
    config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3001'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const ok =
        configured.includes(origin) ||
        /\.ngrok-free\.app$/.test(origin) ||
        /\.ngrok\.app$/.test(origin) ||
        /\.ngrok\.io$/.test(origin);
      return callback(ok ? null : new Error(`CORS bloqueado: ${origin}`), ok);
    },
    credentials: true,
  });

  // Close SSE streams before dying so clients reconnect to another replica
  // instead of hitting a dead socket on every deploy.
  app.enableShutdownHooks();

  const registry = app.get(LocalSseRegistry);
  const shutdown = (signal: string) => {
    const closed = registry.closeAll();
    console.log(
      `[SHUTDOWN] ${signal}: cerrados ${closed} SSE. Los clientes reconectarán a otra réplica.`,
    );
    setTimeout(() => void app.close().then(() => process.exit(0)), 1500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = Number(config.get<string>('PORT') ?? 3000);
  await app.listen(port);
  console.log(
    `API señalización escuchando en :${port} (CORS: ${configured.join(', ')} + *.ngrok)`,
  );
}
bootstrap();
