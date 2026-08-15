import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { LocalSseRegistry } from './signaling/local-sse-registry';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // CORS para el origen del front (el SSE y los POST lo necesitan).
  // CORS_ORIGIN admite una lista separada por comas. Además, para usar la app
  // con otra persona vía ngrok, permitimos cualquier subdominio *.ngrok-free.app
  // y *.ngrok.app sin tener que fijar la URL (ngrok la genera al azar).
  const configured = (config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Sin origin = herramientas tipo curl/Postman → permitir.
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

  /**
   * APAGADO ORDENADO (graceful shutdown).
   *
   * Con varias réplicas detrás de Nginx, un deploy manda SIGTERM a una y
   * levanta otra. Si el proceso muere con los SSE abiertos, el navegador no
   * recibe un cierre limpio y tarda en reaccionar: la llamada se siente
   * cortada. Cerrando los Subjects primero, `EventSource` reconecta solo —y va
   * a otra réplica, porque Nginx ya sacó a esta del upstream—.
   *
   * `enableShutdownHooks` hace que Nest escuche SIGTERM/SIGINT; sin eso el
   * proceso muere de golpe y este código nunca corre.
   */
  app.enableShutdownHooks();

  const registry = app.get(LocalSseRegistry);
  const shutdown = (signal: string) => {
    const closed = registry.closeAll();
    // eslint-disable-next-line no-console
    console.log(
      `[SHUTDOWN] ${signal}: cerrados ${closed} SSE. Los clientes reconectarán a otra réplica.`,
    );
    // Margen para que los cierres salgan por el socket antes de morir. Tiene
    // que ser MENOR que el stop_grace_period del compose, o Docker manda
    // SIGKILL en el medio.
    setTimeout(() => void app.close().then(() => process.exit(0)), 1500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = Number(config.get<string>('PORT') ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `API señalización escuchando en :${port} (CORS: ${configured.join(', ')} + *.ngrok)`,
  );
}
bootstrap();
