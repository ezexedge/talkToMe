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
