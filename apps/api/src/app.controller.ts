import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { LocalSseRegistry } from './signaling/local-sse-registry';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly registry: LocalSseRegistry,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Estado de ESTA réplica: `GET /health/stats`.
   *
   * Nginx open source no expone métricas por upstream (eso es Nginx Plus), así
   * que sin esto no hay forma de ver cómo se repartieron los clientes entre las
   * réplicas. El dato que importa es `sseClients`: cada SSE abierto es un
   * usuario en llamada, y es la medida real de carga de esta app (el CPU no
   * sirve — un socket ocioso no consume casi nada).
   *
   * `instance` viene de la variable de entorno INSTANCE_ID que le pone el
   * compose a cada réplica; sin ella se usa el hostname del contenedor.
   *
   * Es público a propósito: solo expone contadores, ningún dato de usuario.
   */
  @Get('health/stats')
  stats() {
    return {
      instance: process.env.INSTANCE_ID ?? process.env.HOSTNAME ?? 'unknown',
      sseClients: this.registry.clientCount,
      rooms: this.registry.roomCount,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
