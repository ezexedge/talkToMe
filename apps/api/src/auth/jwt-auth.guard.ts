import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

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
      if (this.loadTestSecret && this.isLoadTestRequest(reqForPublic)) {
        (reqForPublic as Request & { user: unknown }).user = {
          auth0Id: this.loadTestSub(reqForPublic),
        };
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    if (this.loadTestSecret && this.isLoadTestRequest(req)) {
      (req as Request & { user: unknown }).user = {
        auth0Id: this.loadTestSub(req),
      };
      return true;
    }

    return super.canActivate(context);
  }

  private isLoadTestRequest(req: Request): boolean {
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
