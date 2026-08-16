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
   * Interruptor del rate limiting, POR ENTORNO.
   *
   * Se apaga de dos formas:
   *
   *   1. `RATE_LIMIT=off` (o `false`/`0`) en el .env — sirve en CUALQUIER
   *      entorno, producción incluida. Es un interruptor de runtime: para
   *      volver a prenderlo alcanza con sacar la variable y reiniciar, sin
   *      tocar código ni hacer deploy.
   *
   *   2. `NODE_ENV=development` — probando a mano se agotan los cupos en
   *      minutos (crear room, entrar, F5, repetir).
   *
   * OJO con el default: acá el limitador queda ACTIVO si la variable falta o
   * trae cualquier otro valor. Apagarlo es siempre una decisión explícita, y
   * un error de tipeo en el .env no puede dejar la API sin protección por
   * accidente.
   */
  private readonly disabled = ((): boolean => {
    const flag = process.env.RATE_LIMIT?.trim().toLowerCase();
    return (
      flag === 'off' ||
      flag === 'false' ||
      flag === '0' ||
      process.env.NODE_ENV === 'development'
    );
  })();

  onModuleInit(): Promise<void> {
    if (this.disabled) {
      // Se avisa fuerte y en el arranque: un rate limiter apagado sin que nadie
      // lo note es peor que no tenerlo, porque se cree que está protegiendo.
      this.logger.warn(
        '[THROTTLE] ⚠️ RATE LIMITING DESACTIVADO ' +
          `(RATE_LIMIT=${process.env.RATE_LIMIT ?? 'unset'}, NODE_ENV=${
            process.env.NODE_ENV ?? 'unset'
          }). La API acepta peticiones SIN LÍMITE.`,
      );
    }
    return super.onModuleInit();
  }

  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (this.disabled) return Promise.resolve(true);
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
