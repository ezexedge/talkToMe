import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca una ruta como PÚBLICA dentro de un controller que está protegido entero.
 *
 * Se usa así (en vez de sacar el guard del controller y ponerlo ruta por ruta)
 * porque el default seguro tiene que ser "protegido": si mañana se agrega un
 * endpoint nuevo y alguien se olvida del guard, queda cerrado y no abierto.
 * Lo público es la excepción y se declara explícitamente.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
