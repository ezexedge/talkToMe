import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { User } from '../users/user.entity';

/**
 * `@CurrentUser()` inyecta el usuario ya persistido en Neon (lo dejó ahí
 * `JwtStrategy.validate`). Solo tiene sentido en rutas con `JwtAuthGuard`: sin
 * el guard, `req.user` viene vacío.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    return ctx.switchToHttp().getRequest().user as User;
  },
);

/**
 * `@Auth0Sub()` inyecta directamente el `sub` de Auth0 del usuario autenticado.
 *
 * Es la identidad que usa la señalización como `clientId`. Viene del token
 * verificado, NUNCA del body ni del query: si confiáramos en lo que manda el
 * cliente, cualquiera podría publicar señalización haciéndose pasar por otro.
 */
export const Auth0Sub = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    return (ctx.switchToHttp().getRequest().user as User).auth0Id;
  },
);
