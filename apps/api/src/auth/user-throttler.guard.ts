import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request } from 'express';
import { User } from '../users/user.entity';

/**
 * Rate limiting POR USUARIO, no por IP.
 *
 * El tracker por defecto de @nestjs/throttler usa la IP, y eso castiga a todos
 * los que comparten salida: una escuela, una oficina, o cualquier operadora
 * móvil con CGNAT (miles de teléfonos detrás de una sola IP). Diez alumnos
 * practicando desde el mismo wifi agotarían juntos el cupo de ICE aunque cada
 * uno se comporte normal.
 *
 * Todos los endpoints están detrás de JwtAuthGuard, así que el `sub` de Auth0
 * está disponible en cada request y es el identificador correcto.
 *
 * Ojo con lo que esto NO cubre: alguien que crea muchas cuentas de Auth0 tiene
 * un cupo por cada una. Eso se ataja del lado de Auth0 (verificación de email,
 * bot detection), no acá.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(UserThrottlerGuard.name);

  protected getTracker(req: Request): Promise<string> {
    const sub = (req.user as User | undefined)?.auth0Id;

    // Sin usuario (endpoints @Public) se cae a la IP: es lo único que hay.
    return Promise.resolve(sub ?? req.ip ?? 'unknown');
  }

  /**
   * Se loguea cada bloqueo ANTES de lanzar el 429.
   *
   * Los límites son estimaciones, no valores medidos: se eligieron con margen
   * (~10x la ráfaga esperada) para no cortar a nadie real. Estos logs son los
   * que van a decir si hay que apretarlos o aflojarlos.
   */
  protected async throwThrottlingException(
    context: Parameters<ThrottlerGuard['throwThrottlingException']>[0],
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<Request>();
    const who = (req.user as User | undefined)?.auth0Id ?? req.ip ?? 'unknown';

    this.logger.warn(
      `[THROTTLE] 🚦 429 ${req.method} ${req.originalUrl} | user=${who} | ` +
        `límite=${detail.limit}/${detail.ttl / 1000}s`,
    );

    return super.throwThrottlingException(context, detail);
  }
}
