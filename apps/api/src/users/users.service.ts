import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

export interface Auth0Claims {
  sub: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly repo: Repository<User>,
  ) {}

  async upsertFromAuth0(claims: Auth0Claims): Promise<User> {
    await this.repo.upsert(
      {
        auth0Id: claims.sub,
        email: claims.email ?? undefined,
        name: claims.name ?? undefined,
        givenName: claims.givenName ?? undefined,
        familyName: claims.familyName ?? undefined,
        picture: claims.picture ?? undefined,
      },
      { conflictPaths: ['auth0Id'], skipUpdateIfNoValuesChanged: true },
    );

    const user = await this.repo.findOneByOrFail({ auth0Id: claims.sub });
    this.logger.log(`[USER-01] 👤 upsert ok | auth0Id=${claims.sub} id=${user.id}`);
    return user;
  }

  findByAuth0Id(auth0Id: string): Promise<User | null> {
    return this.repo.findOneBy({ auth0Id });
  }
}
