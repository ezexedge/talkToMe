import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from './user.entity';
import { UserCacheService, type PublicProfile } from './user-cache.service';

@Controller('users')
export class UsersController {
  constructor(private readonly cache: UserCacheService) {}

  /**
   * Perfiles públicos por `sub` de Auth0: `GET /users/profiles?subs=a,b`.
   *
   * Lo usa la sala para mostrar el nombre y la foto del peer, que por SSE llega
   * solo como id. Resuelve desde Redis (con fallback a Postgres), o sea el
   * mismo camino barato que el lobby.
   *
   * Exige sesión: son identidades de terceros, igual que en el lobby. Y devuelve
   * SOLO nombre y foto — nunca el email, que no hace falta para pintar un
   * avatar y sería exponer de más.
   */
  @Get('profiles')
  @UseGuards(JwtAuthGuard)
  async profiles(@Query('subs') subs?: string): Promise<PublicProfile[]> {
    const list = (subs ?? '').split(',').filter(Boolean);
    if (list.length === 0) return [];
    const found = await this.cache.getMany(list);
    return list.map(
      (sub) => found.get(sub) ?? { sub, name: null, picture: null },
    );
  }
  /**
   * Perfil del usuario logueado, tal como quedó guardado en Neon.
   *
   * El front lo usa para confirmar que el backend aceptó el token y que la fila
   * existe. Llegar acá con 200 significa que el upsert ya corrió.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    return {
      id: user.id,
      auth0Id: user.auth0Id,
      email: user.email,
      name: user.name,
      givenName: user.givenName,
      familyName: user.familyName,
      picture: user.picture,
      createdAt: user.createdAt,
    };
  }
}
