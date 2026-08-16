import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LocalSseRegistry } from './signaling/local-sse-registry';

describe('AppController', () => {
  let appController: AppController;

  // El registry real abre conexiones SSE y mantiene estado en RAM. Acá solo
  // interesan los contadores que lee /health/stats, así que se mockea con un
  // objeto plano en vez de instanciar la clase entera.
  const registryMock = { clientCount: 2, roomCount: 1 };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: LocalSseRegistry, useValue: registryMock },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  // Este es el endpoint que Caddy consulta como health check (health_uri en el
  // Caddyfile): si deja de responder, la réplica sale del pool.
  describe('health/stats', () => {
    it('reporta los contadores del registry local', () => {
      const stats = appController.stats();

      expect(stats.sseClients).toBe(2);
      expect(stats.rooms).toBe(1);
      expect(typeof stats.uptimeSeconds).toBe('number');
    });

    it('identifica la instancia con INSTANCE_ID', () => {
      process.env.INSTANCE_ID = 'api1';

      expect(appController.stats().instance).toBe('api1');

      delete process.env.INSTANCE_ID;
    });
  });
});
