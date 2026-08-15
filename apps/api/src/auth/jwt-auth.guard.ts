import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard de autenticación. Rechaza con 401 si no hay token válido.
 *
 * Sirve tanto para los POST (token en `Authorization: Bearer`) como para el SSE
 * (token en `?token=`), porque la JwtStrategy prueba ambos extractores. No hace
 * falta un guard aparte para el stream.
 *
 * Deja pasar sin token las rutas marcadas con `@Public()`. Se mira tanto el
 * handler como la clase para que el decorador funcione sobre un método suelto
 * dentro de un controller protegido entero.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  /**
   * Secreto del modo prueba de carga. Solo se habilita si:
   *   1. `LOAD_TEST_SECRET` está definido en el entorno, Y
   *   2. `NODE_ENV !== 'production'`.
   *
   * Ambas condiciones se evalúan UNA vez, al construir el guard, para que no
   * se pueda activar en caliente. En producción queda apagado aunque alguien
   * filtre el secreto por error.
   */
  private readonly loadTestSecret: string | null;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    super();
    const secret = config.get<string>('LOAD_TEST_SECRET');
    const isProd = config.get<string>('NODE_ENV') === 'production';
    this.loadTestSecret = secret && !isProd ? secret : null;
    if (this.loadTestSecret) {
      this.logger.warn(
        '⚠️  MODO PRUEBA DE CARGA ACTIVO: se acepta el header x-load-test. Nunca en producción.',
      );
    }
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const reqForPublic = context.switchToHttp().getRequest<Request>();
    if (isPublic) {
      // Aun en rutas públicas se resuelve la identidad de prueba si viene: hay
      // endpoints públicos que enriquecen su respuesta cuando reconocen al
      // usuario (el lobby marca cuáles salas son tuyas), y sin esto no se
      // podrían probar con el modo de carga.
      if (this.loadTestSecret && this.isLoadTestRequest(reqForPublic)) {
        (reqForPublic as Request & { user: unknown }).user = {
          auth0Id: this.loadTestSub(reqForPublic),
        };
      }
      return true;
    }

    // Bypass SOLO para la prueba de carga: simular N usuarios exigiría N
    // tokens reales de Auth0, y el objetivo de la prueba es medir SSE + Redis,
    // no el JWKS.
    //
    // El cliente manda su identidad simulada en `x-load-test-sub`, así que cada
    // usuario falso tiene un `sub` propio y la membresía de salas se comporta
    // igual que en producción (un usuario, un lugar).
    const req = context.switchToHttp().getRequest<Request>();
    if (this.loadTestSecret && this.isLoadTestRequest(req)) {
      // La estrategia normal deja el User de la DB en req.user; acá ponemos un
      // objeto mínimo con la única propiedad que la señalización usa.
      (req as Request & { user: unknown }).user = {
        auth0Id: this.loadTestSub(req),
      };
      return true;
    }

    return super.canActivate(context);
  }

  private isLoadTestRequest(req: Request): boolean {
    // El header no viaja en el SSE (EventSource no manda headers), así que se
    // acepta también por query, igual que el token.
    const fromHeader = req.headers?.['x-load-test'];
    const fromQuery = req.query?.loadTest;
    const provided =
      (typeof fromHeader === 'string' ? fromHeader : undefined) ??
      (typeof fromQuery === 'string' ? fromQuery : undefined);
    return provided === this.loadTestSecret;
  }

  private loadTestSub(req: Request): string {
    const h = req.headers?.['x-load-test-sub'];
    const q = req.query?.loadTestSub;
    return (
      (typeof h === 'string' ? h : undefined) ??
      (typeof q === 'string' ? q : undefined) ??
      'loadtest|anonymous'
    );
  }
}
