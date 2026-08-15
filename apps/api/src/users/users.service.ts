import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

/** Claims que nos interesan del ID/access token de Auth0. */
export interface Auth0Claims {
  sub: string;
  email?: string;
  /** Nombre completo. */
  name?: string;
  /** Nombre de pila (`given_name` en OIDC). */
  givenName?: string;
  /** Apellido (`family_name` en OIDC). */
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

  /**
   * Crea o actualiza el usuario a partir de los claims de Auth0.
   *
   * No hay endpoint de "registro": la primera vez que alguien entra con Google,
   * su token llega acá y la fila se crea sola. Auth0 ya verificó la identidad,
   * así que un registro aparte solo agregaría un paso que puede fallar y dejar
   * un usuario autenticado pero inexistente en nuestra DB.
   *
   * Se implementa con un UPSERT atómico (`ON CONFLICT (auth0Id) DO UPDATE`) en
   * vez de un SELECT-then-INSERT: dos requests del mismo usuario recién creado
   * pueden llegar en paralelo (el front dispara varias llamadas al cargar), y
   * el chequeo previo dejaría una ventana donde ambos ven "no existe" y el
   * segundo INSERT explota por el índice único.
   */
  async upsertFromAuth0(claims: Auth0Claims): Promise<User> {
    // Los claims de perfil (email/name/picture) solo viajan en el token si se
    // pidieron los scopes correspondientes. Si no vinieron, mandamos undefined
    // para NO pisar con null un dato bueno que ya teníamos guardado.
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

    // `upsert` no devuelve la fila completa en todos los drivers, así que la
    // releemos por su clave única.
    const user = await this.repo.findOneByOrFail({ auth0Id: claims.sub });
    this.logger.log(`[USER-01] 👤 upsert ok | auth0Id=${claims.sub} id=${user.id}`);
    return user;
  }

  findByAuth0Id(auth0Id: string): Promise<User | null> {
    return this.repo.findOneBy({ auth0Id });
  }
}
