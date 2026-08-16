import { applyDecorators } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

/**
 * Nombres de todos los throttlers declarados en AppModule.
 *
 * Si se agrega uno nuevo allá, va también acá: es lo que permite que
 * `@OnlyThrottle` saltee "todos menos uno" sin listarlos en cada endpoint.
 */
export const THROTTLER_NAMES = [
  'default',
  'ice',
  'sdp',
  'rooms',
  'list',
  'actions',
] as const;

export type ThrottlerName = (typeof THROTTLER_NAMES)[number];

/**
 * Aplica UN límite y saltea todos los demás.
 *
 * Hace falta porque `@Throttle({ x: ... })` NO limita el endpoint al throttler
 * `x`: el guard recorre TODOS los throttlers configurados en el módulo y aplica
 * cada uno, quedándose con el más restrictivo. Un `@Post('offer')` con
 * `@Throttle({ sdp: ... })` seguía sujeto además a `rooms` (5/min), así que la
 * señalización moría por un límite pensado para crear rooms.
 *
 * Con este decorador, cada endpoint responde solo al cupo que le corresponde.
 */
export function OnlyThrottle(name: ThrottlerName, limit: number, ttl = 60_000) {
  const skip = Object.fromEntries(
    THROTTLER_NAMES.filter((n) => n !== name).map((n) => [n, true]),
  );

  return applyDecorators(
    Throttle({ [name]: { limit, ttl } }),
    SkipThrottle(skip),
  );
}
