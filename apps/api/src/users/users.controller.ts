import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from './user.entity';
import { UserCacheService, type PublicProfile } from './user-cache.service';

@Controller('users')
export class UsersController {
  constructor(private readonly cache: UserCacheService) {}

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
