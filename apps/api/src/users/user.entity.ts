import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Usuario de la app, espejado desde Auth0.
 *
 * Auth0 es la fuente de verdad de la IDENTIDAD (quién sos, cómo te
 * autenticaste); esta tabla es la fuente de verdad de lo NUESTRO (id interno
 * estable, y lo que le colguemos después: historial de llamadas, preferencias).
 * Por eso guardamos una copia del perfil en vez de pegarle a Auth0 en cada
 * request.
 */
@Entity('users')
export class User {
  /**
   * PK interna. Deliberadamente NO usamos el `sub` de Auth0 como PK: si algún
   * día se cambia de proveedor de identidad, las FKs de otras tablas siguen
   * siendo válidas y solo hay que remapear `auth0Id`.
   */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * El `sub` del token de Auth0 (ej. `google-oauth2|1234567890`). Es el enlace
   * con el proveedor y por eso es único e indexado: se busca por él en CADA
   * request autenticado.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  auth0Id: string;

  /**
   * Nullable a propósito: un token de Auth0 puede no traer email si el scope
   * `email` no fue concedido. No lo marcamos único porque la misma persona
   * podría entrar por dos conexiones distintas (Google y user/pass) y generar
   * dos usuarios con el mismo email — unificarlos es account linking, fuera del
   * alcance del MVP.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  /** Nombre completo tal como lo da el proveedor (ej. "Ezequiel Gallardo"). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  /**
   * Nombre y apellido por separado.
   *
   * Google los manda desagregados (`given_name` / `family_name`), así que se
   * guardan tal cual en vez de partir `name` por el espacio: esa heurística
   * falla con apellidos compuestos ("Ana María De la Torre") y con culturas
   * donde el orden es al revés.
   *
   * Nullable porque no todo proveedor los manda.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  givenName: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  familyName: string | null;

  /** URL del avatar que da Google vía Auth0. */
  @Column({ type: 'text', nullable: true })
  picture: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Se refresca en cada login, así sirve de "última vez que entró". */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
