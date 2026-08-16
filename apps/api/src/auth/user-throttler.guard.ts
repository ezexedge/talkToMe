import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request, Response } from 'express';
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

  /**
   * En desarrollo el rate limiting se saltea por completo.
   *
   * Probando a mano se agotan los cupos en minutos (crear room, entrar, F5,
   * repetir) y el 429 resultante se ve en el navegador como un error de CORS,
   * que manda a buscar el problema donde no está.
   *
   * PRODUCCIÓN ES EL DEFAULT SEGURO: solo se saltea con NODE_ENV EXACTAMENTE
   * 'development'. Si la variable falta, viene vacía o trae cualquier otro
   * valor, el límite se aplica. Un error de configuración deja el limitador
   * ACTIVO, nunca apagado.
   */
  private readonly isDev = process.env.NODE_ENV === 'development';

  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (this.isDev) return Promise.resolve(true);
    return super.shouldSkip(context);
  }

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
    const res = context.switchToHttp().getResponse<Response>();
    const who = (req.user as User | undefined)?.auth0Id ?? req.ip ?? 'unknown';

    this.logger.warn(
      `[THROTTLE] 🚦 429 ${req.method} ${req.originalUrl} | user=${who} | ` +
        `límite=${detail.limit}/${detail.ttl / 1000}s`,
    );

    // El 429 se lanza desde un guard, o sea ANTES de que la respuesta pase por
    // el middleware de CORS. Sin estos headers el navegador no ve un 429: ve un
    // "error de CORS", y el 429 real queda invisible en la consola. Eso manda a
    // depurar el CORS cuando el problema es el rate limit.
    const origin = req.headers.origin;
    if (origin && !res.headersSent) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
    }

    return super.throwThrottlingException(context, detail);
  }
}
