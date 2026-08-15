import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Logger,
  MessageEvent,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, Subject } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { LocalSseRegistry } from './local-sse-registry';
import { RedisPubSubService } from './redis-pubsub.service';
import { RoomsService } from './rooms.service';
import { SignalMessage } from './types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Auth0Sub } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import {
  UserCacheService,
  type PublicProfile,
} from '../users/user-cache.service';

/**
 * Los DTO ya NO llevan `clientId`.
 *
 * La identidad del emisor sale del token verificado (el `sub` de Auth0), nunca
 * del body: si viniera del cliente, cualquiera podría publicar señalización
 * firmada con el id de otro y, por ejemplo, expulsar en su nombre.
 */
interface OfferDto {
  roomId: string;
  sdp: unknown;
}
interface AnswerDto {
  roomId: string;
  sdp: unknown;
}
interface IceDto {
  roomId: string;
  candidate: unknown;
}
interface LeaveDto {
  roomId: string;
}
interface MuteDto {
  roomId: string;
  muted: boolean;
}
interface KickDto {
  roomId: string;
  /** A quién se expulsa (el `sub` de Auth0 del otro). */
  targetId: string;
}

/**
 * Toda la señalización exige usuario logueado (Auth0).
 *
 * El `clientId` de una room ES el `sub` de Auth0. Eso tiene dos consecuencias
 * buscadas: la identidad sobrevive al F5 sin depender de sessionStorage, y un
 * mismo usuario no puede ocupar los DOS lugares de una room abriendo dos
 * pestañas (la segunda entra por la rama de reconexión).
 */
@Controller('signaling')
@UseGuards(JwtAuthGuard)
export class SignalingController {
  private readonly logger = new Logger(SignalingController.name);

  /** Cada cuánto late el SSE (refresca el TTL y detecta sockets muertos). */
  private static readonly HEARTBEAT_MS = 20_000;

  constructor(
    private readonly registry: LocalSseRegistry,
    private readonly rooms: RoomsService,
    private readonly redis: RedisPubSubService,
    private readonly userCache: UserCacheService,
    private readonly jwtVerifier: JwtVerifierService,
  ) {}

  /**
   * Lobby: lista las rooms activas con su nº de miembros, para que el front
   * muestre cuáles existen y si se puede unir (count < 2). Las rooms que se
   * quedaron vacías siguen apareciendo en 0/2 durante unos segundos, con
   * `expiresInSeconds` = lo que falta para que Redis las borre.
   * GET /signaling/rooms
   *
   * PÚBLICO a propósito: el Home se puede ver sin estar logueado, y el lobby es
   * su contenido principal. Lo que expone es inocuo (nombre de la room y cuánta
   * gente hay), y para ENTRAR sí hace falta sesión — que es donde está el
   * control real.
   */
  @Public()
  @Get('rooms')
  async listRooms(@Req() req: Request): Promise<
    Array<{
      roomId: string;
      count: number;
      expiresInSeconds: number | null;
      members: PublicProfile[];
      /** ¿El usuario que consulta es el dueño? Para mostrarle "Delete". */
      isOwner: boolean;
    }>
  > {
    const rooms = await this.rooms.listRooms();

    // Los avatares y nombres SOLO se envían a usuarios logueados. Ver el lobby
    // es público (salas y ocupación), pero saber QUIÉN está en llamada es
    // identidad de terceros y no se expone a visitantes anónimos.
    //
    // La ruta es @Public(), así que acá no hay guard que haya poblado req.user:
    // validamos el token a mano y, si no es válido, devolvemos la lista sin
    // miembros en vez de rechazar.
    const viewerSub = await this.viewerSub(req);
    if (!viewerSub) {
      return rooms.map(({ roomId, count, expiresInSeconds }) => ({
        roomId,
        count,
        expiresInSeconds,
        members: [],
        // Sin sesión no hay dueño posible: nadie ve el botón de borrar.
        isOwner: false,
      }));
    }

    // Una sola resolución para TODAS las salas: junta los subs, pega una vez a
    // Redis (pipeline) y solo va a Postgres por los que falten.
    const allSubs = rooms.flatMap((r) => r.members);
    const profiles = await this.userCache.getMany(allSubs);

    return rooms.map(({ roomId, count, expiresInSeconds, members, owner }) => ({
      roomId,
      count,
      expiresInSeconds,
      members: members.map(
        (sub) => profiles.get(sub) ?? { sub, name: null, picture: null },
      ),
      // Se envía el BOOLEAN ya resuelto y no el `sub` del dueño: el front solo
      // necesita saber si mostrar el botón, y así no se expone la identidad del
      // creador a quien no es él.
      isOwner: owner !== null && owner === viewerSub,
    }));
  }

  /**
   * `sub` del usuario que hace la consulta, o null si no hay token válido.
   *
   * Se usa solo en rutas públicas que enriquecen su respuesta cuando hay
   * sesión. Devuelve null ante cualquier problema (sin token, expirado, firma
   * inválida): no es un control de acceso, es una decisión de cuánto mostrar.
   */
  private async viewerSub(req: Request): Promise<string | null> {
    // El guard ya resolvió la identidad si el request venía autenticado por la
    // vía normal o por el bypass de prueba de carga. Se aprovecha eso antes de
    // volver a validar el token a mano.
    const fromGuard = (req as Request & { user?: { auth0Id?: string } }).user;
    if (fromGuard?.auth0Id) return fromGuard.auth0Id;

    const header = req.headers?.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;
    if (!token) return null;
    try {
      const payload = await this.jwtVerifier.verify(token);
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /**
   * SSE: el navegador RECIBE por aquí (nunca por WebSocket).
   * GET /signaling/stream?roomId=...&token=...
   *
   * El token va en el QUERY y no en un header porque `EventSource` no permite
   * mandar cabeceras. El `clientId` NO se recibe: se deriva del `sub` del token.
   *
   * Orden de operaciones al abrir:
   *  1. Crear el Subject local y registrarlo en el Map (estado en RAM justificado).
   *  2. Suscribir esta instancia al canal Redis de la room (solo si es el 1er
   *     cliente local de esa room en esta instancia).
   *  3. Resolver membresía vía Redis SET:
   *       0 miembros → añadir; NO initiator (espera la oferta).
   *       1 miembro  → añadir; ES initiator → publicar peer-joined a ESTE cliente
   *                    (el segundo en entrar es el initiator, evita glare).
   *       2 miembros → room llena → room-full local y cerrar.
   */
  @Sse('stream')
  stream(
    @Auth0Sub() clientId: string,
    @Query('roomId') roomId: string,
  ): Observable<MessageEvent> {
    this.logger.log(
      `[SSE-01] 🔌 Cliente abre stream SSE | clientId=${clientId} room=${roomId}`,
    );
    const subject = new Subject<MessageEvent>();

    // (1) registrar el Subject local.
    this.registry.addClient(clientId, subject);
    this.logger.log(
      `[SSE-02] 📥 Subject guardado en Map local de esta instancia | clientId=${clientId}`,
    );

    // El resto es async; lo lanzamos sin bloquear la apertura del stream.
    // El .catch() es imprescindible: sin él, un fallo acá se convierte en una
    // promesa rechazada sin manejar y el stream queda abierto sin haber entrado
    // nunca a la sala, sin dejar rastro en los logs.
    void this.onClientConnect(clientId, roomId, subject).catch((e) => {
      this.logger.error(
        `[SSE-FATAL] ❌ onClientConnect falló | clientId=${clientId} room=${roomId}: ${(e as Error)?.stack ?? e}`,
      );
    });

    // Heartbeat: cumple dos funciones a la vez.
    //  1. Refresca el TTL de la room en Redis. El TTL es corto a propósito, así
    //     que si esta instancia muere de golpe nadie lo refresca y la room se
    //     expira sola en lugar de quedar ocupada por un cliente fantasma.
    //  2. Escribe bytes en el socket. Una conexión muerta (túnel caído, wifi
    //     cortado) no siempre emite un evento de cierre; al intentar escribir,
    //     el error aflora y `finalize` se dispara.
    const beat = setInterval(() => {
      void this.rooms.touch(roomId, clientId);
      subject.next({ data: { type: 'ping', from: 'server' } as SignalMessage });
    }, SignalingController.HEARTBEAT_MS);

    // `finalize` corre cuando el stream se cierra por CUALQUIER motivo: el
    // navegador se fue, se cayó la red, se mató la pestaña. Sin esto, un
    // cliente que no alcanzó a hacer `leave` quedaba en el SET de Redis hasta
    // el TTL de 1h, y el lobby mostraba la room ocupada por un fantasma.
    //
    // La baja es INMEDIATA, sin ventana de gracia: cerrar el SSE —por F5, por
    // cerrar la pestaña o por perder la red— se trata como salir de la sala.
    // Quien recarga vuelve a entrar como participante nuevo.
    //
    // Antes había una gracia de 5s para que un F5 no te sacara de tu propia
    // llamada. Se quitó a pedido: la contra es que recargar sin querer te echa,
    // y si en ese lapso entra alguien más, tu lugar queda ocupado.
    return subject.asObservable().pipe(
      finalize(() => {
        clearInterval(beat);
        this.logger.log(
          `[SSE-99] 🔌 SSE cerrado | clientId=${clientId} room=${roomId} → lo saco de la sala YA`,
        );
        void this.releaseMember(clientId, roomId);
      }),
    );
  }

  private async onClientConnect(
    clientId: string,
    roomId: string,
    subject: Subject<MessageEvent>,
  ): Promise<void> {
    try {
      // (2) suscribir la instancia al canal Redis si es el primer cliente local.
      if (this.registry.incrementRoom(roomId)) {
        await this.redis.subscribe(roomId);
        this.logger.log(
          `[SSE-03] 📡 Primer cliente local de room=${roomId} en esta instancia → SUSCRITO al canal Redis room:${roomId}`,
        );
      } else {
        this.logger.log(
          `[SSE-03] 📡 Ya había clientes locales en room=${roomId}, no re-suscribo el canal Redis`,
        );
      }

      // (3) membresía vía Redis SET.
      // Primero: ¿este clientId YA es miembro? Entonces es una RECONEXIÓN
      // (típicamente un F5: el navegador volvió con su clientId persistido y su
      // id sigue en el SET porque no hizo `leave`). En ese caso NO aplicamos el
      // límite de 2 ni lo re-añadimos: solo reabrimos su SSE.
      const alreadyMember = await this.rooms.isMember(roomId, clientId);
      this.logger.log(
        `[SSE-04] 🔢 Abriendo stream en room=${roomId} | ¿este id ya estaba? ${alreadyMember}`,
      );

      // YA NO HAY RECONEXIÓN: el F5 saca de la sala.
      //
      // Al cerrarse el SSE la baja es inmediata, así que quien recarga vuelve
      // como participante NUEVO y pasa por el flujo normal de abajo. El otro se
      // entera dos veces —`peer-left` al recargar y `peer-arrived` al volver—,
      // que es justamente lo pedido.
      //
      // `alreadyMember` puede ser true igual si el SREM de la baja todavía no
      // se aplicó cuando llega el SADD nuevo (el navegador reabre el stream en
      // milisegundos). En ese caso se lo quita primero, para que la entrada
      // cuente de cero y el conteo de miembros no quede inflado.
      if (alreadyMember) {
        this.logger.log(
          `[SSE-04c] ♻️ ${clientId} seguía en el SET (baja aún no aplicada) → lo saco antes de re-entrar`,
        );
        await this.rooms.removeMember(roomId, clientId);
      }

      // El conteo se lee DESPUÉS de la limpieza de arriba: si no, un F5 se
      // contaría a sí mismo y la sala parecería más llena de lo que está.
      const count = await this.rooms.countMembers(roomId);

      // Un usuario logueado solo puede estar en UNA room a la vez.
      //
      // Este chequeo va DESPUÉS del de reconexión a propósito: si `alreadyMember`
      // fuera true ya salimos arriba, así que acá sabemos que quiere entrar a
      // una room DISTINTA de la suya. Al ser el clientId el `sub` de Auth0, la
      // regla aplica a la persona y no a la pestaña: no la esquiva abriendo
      // otra pestaña ni otro navegador.
      const currentRoom = await this.rooms.getCurrentRoom(clientId);
      if (currentRoom && currentRoom !== roomId) {
        this.logger.warn(
          `[SSE-04b] 🚫 clientId=${clientId} YA está en room=${currentRoom} → rechazo su entrada a room=${roomId}`,
        );
        subject.next({
          data: {
            type: 'already-in-room',
            from: 'server',
            to: clientId,
            payload: { roomId: currentRoom },
          } as SignalMessage,
        });
        this.cleanupLocal(clientId, roomId);
        subject.complete();
        return;
      }

      // Chequeo rápido: si YA se ven 2, ni intentamos entrar. No alcanza por sí
      // solo (dos clientes simultáneos pueden leer 1 los dos), así que abajo se
      // revalida con el tamaño real que devuelve el SADD.
      if (count >= 2) {
        // Room llena (con OTROS dos): avisar SOLO a este cliente y cerrar.
        this.logger.warn(
          `[SSE-05] 🚫 Room LLENA (2/2) | clientId=${clientId} → envío 'room-full' y cierro su SSE`,
        );
        subject.next({ data: { type: 'room-full', from: 'server' } as SignalMessage });
        this.cleanupLocal(clientId, roomId);
        subject.complete();
        return;
      }

      // `size` = miembros DESPUÉS de agregarme. Se usa esto y no el `count`
      // leído arriba porque entre aquel SCARD y este SADD puede haber entrado
      // el otro cliente: con dos entradas casi simultáneas ambos leían 0, los
      // dos se creían el primero, y nadie ofertaba. El valor que devuelve el
      // SADD es la única lectura que no puede mentir sobre mi posición.
      const size = await this.rooms.addMember(roomId, clientId);
      this.logger.log(
        `[SSE-06] ✅ clientId=${clientId} AÑADIDO al SET de room=${roomId} (ahora ${size}/2)`,
      );

      // Revalidación tras el SADD: si tres clientes entraron a la vez, los tres
      // pudieron pasar el chequeo de arriba y acá el tercero se ve a sí mismo
      // como miembro 3. Se deshace su entrada y se lo rechaza.
      if (size > 2) {
        this.logger.warn(
          `[SSE-06b] 🚫 Room LLENA por carrera (${size}/2) | saco a ${clientId} y le aviso`,
        );
        await this.rooms.removeMember(roomId, clientId);
        subject.next({
          data: { type: 'room-full', from: 'server' } as SignalMessage,
        });
        this.cleanupLocal(clientId, roomId);
        subject.complete();
        return;
      }

      // (el estado inicial del participante lo deja addMember, en el mismo
      // script Lua, para no pagar otro round-trip)

      // Avisar el rol DESPUÉS de addMember: es ahí donde se decide el dueño
      // (SET NX), así que antes todavía no habría a quién consultar.
      await this.sendRole(subject, roomId, clientId);

      if (size === 2) {
        // Soy el SEGUNDO en el SET → soy el initiator (creo la oferta).
        // El initiator SIEMPRE está conectado localmente a ESTA instancia (es
        // quien acaba de abrir el SSE acá), así que le empujamos el peer-joined
        // DIRECTO por su Subject local. No hace falta ir por Redis: el destino
        // es este mismo cliente, y así evitamos la carrera de que el mensaje
        // vuelva por Pub/Sub antes de que el SSE esté listo.
        this.logger.log(
          `[SSE-07] 👑 clientId=${clientId} es el SEGUNDO en entrar → es INITIATOR. Le envío 'peer-joined' directo por su SSE local para que cree la oferta`,
        );
        subject.next({
          data: { type: 'peer-joined', from: 'server', to: clientId } as SignalMessage,
        });

        // Avisar al que YA estaba que llegó alguien.
        //
        // Sin esto, el que esperaba no recibía NINGUNA señal de la llegada: su
        // UI solo reaccionaba cuando empezaba a llegar audio por WebRTC, y si
        // había quedado en 'disconnected' tras una salida anterior, se quedaba
        // ahí aunque el otro ya hubiera vuelto.
        //
        // Va por Redis (y no por el Subject local) porque el que espera puede
        // estar conectado en OTRA instancia. Se manda `peer-arrived` y no
        // `peer-joined` porque este último ordena crear la oferta, y si los dos
        // ofertaran habría glare.
        const waiting = await this.rooms.getPeer(roomId, clientId);
        if (waiting) {
          this.logger.log(
            `[SSE-07b] 📣 Aviso a ${waiting} que llegó ${clientId} (peer-arrived)`,
          );
          await this.redis.publish(roomId, {
            type: 'peer-arrived',
            from: clientId,
            to: waiting,
          });

          // SNAPSHOT del estado del que ya estaba, para el que ACABA de entrar.
          //
          // Sin esto, si el otro se silenció ANTES de que yo llegara, su
          // `peer-muted` ya pasó y nunca me alcanza: lo vería con el micrófono
          // abierto. Los eventos no tienen memoria; el estado en Redis sí.
          const peerState = await this.rooms.getMemberState(roomId, waiting);
          this.logger.log(
            `[SSE-07c] 📸 Estado actual de ${waiting}: muted=${peerState.muted} → se lo mando al que entra`,
          );
          subject.next({
            data: {
              type: 'peer-muted',
              from: waiting,
              to: clientId,
              payload: { muted: peerState.muted },
            } as SignalMessage,
          });
        }
      } else {
        this.logger.log(
          `[SSE-07] ⏳ clientId=${clientId} es el PRIMERO → NO initiator. Queda esperando a que entre el peer`,
        );
      }
    } catch (e) {
      this.logger.error(`[SSE-ERR] ❌ onClientConnect: ${(e as Error).message}`);
      subject.error(e);
    }
  }

  /**
   * Le dice al cliente si es el DUEÑO de la room, para que el front sepa si
   * mostrar el botón de expulsar. Va directo por su Subject local (el destino
   * es este mismo cliente, no hace falta pasar por Redis).
   *
   * Es información para la UI únicamente: el permiso real se re-valida contra
   * Redis en cada POST /kick.
   */
  private async sendRole(
    subject: Subject<MessageEvent>,
    roomId: string,
    clientId: string,
  ): Promise<void> {
    const isOwner = await this.rooms.isOwner(roomId, clientId);
    this.logger.log(
      `[SSE-08] ${isOwner ? '👑' : '🙋'} clientId=${clientId} isOwner=${isOwner} en room=${roomId} → le mando su rol`,
    );
    subject.next({
      data: {
        type: 'role',
        from: 'server',
        to: clientId,
        payload: { isOwner },
      } as SignalMessage,
    });
  }

  /**
   * El SSE se cierra cuando el Subject se completa o el cliente desconecta.
   * NestJS no nos da un hook directo de "cerró el SSE" sobre el Subject, así
   * que el cierre limpio se dispara por POST /leave (colgar) y por el unload
   * del navegador (que también llama a /leave vía sendBeacon).
   */

  @Post('offer')
  @HttpCode(202)
  async offer(
    @Auth0Sub() clientId: string,
    @Body() dto: OfferDto,
  ): Promise<{ ok: true }> {
    this.logger.log(
      `[POST-01] 📤 OFFER recibida por POST | from=${clientId} room=${dto.roomId} → publico en Redis room:${dto.roomId}`,
    );
    await this.redis.publish(dto.roomId, {
      type: 'offer',
      from: clientId,
      payload: dto.sdp,
    });
    return { ok: true };
  }

  @Post('answer')
  @HttpCode(202)
  async answer(
    @Auth0Sub() clientId: string,
    @Body() dto: AnswerDto,
  ): Promise<{ ok: true }> {
    this.logger.log(
      `[POST-02] 📤 ANSWER recibida por POST | from=${clientId} room=${dto.roomId} → publico en Redis room:${dto.roomId}`,
    );
    await this.redis.publish(dto.roomId, {
      type: 'answer',
      from: clientId,
      payload: dto.sdp,
    });
    return { ok: true };
  }

  @Post('ice-candidate')
  @HttpCode(202)
  async ice(
    @Auth0Sub() clientId: string,
    @Body() dto: IceDto,
  ): Promise<{ ok: true }> {
    this.logger.log(
      `[POST-03] 🧊 ICE-CANDIDATE recibido por POST | from=${clientId} room=${dto.roomId} → publico en Redis room:${dto.roomId}`,
    );
    await this.redis.publish(dto.roomId, {
      type: 'ice-candidate',
      from: clientId,
      payload: dto.candidate,
    });
    return { ok: true };
  }

  /**
   * Expulsar al peer. SOLO el DUEÑO de la room (el primero que entró, o sea el
   * creador) puede hacerlo; el invitado no.
   *
   * La autorización se valida ACÁ, en el server, y no en el front: ocultar el
   * botón al invitado es solo cosmético, cualquiera podría mandar el POST a
   * mano. El dueño se lee de Redis (`room:{id}:owner`) porque esta instancia no
   * es necesariamente la misma donde el dueño tiene su SSE abierto.
   *
   * ORDEN DE OPERACIONES (importa):
   *  1. Validar que quien echa ES el dueño de la room.
   *  2. PUBLICAR el 'kicked' dirigido al expulsado ANTES de sacarlo del SET.
   *     El dispatch de Redis solo entrega a quienes son miembros según el SET,
   *     así que si lo removiéramos primero el mensaje no le llegaría nunca y
   *     se quedaría colgado en la room sin enterarse.
   *  3. Recién ahí quitarlo del SET y avisar 'peer-left' al resto.
   */
  @Post('kick')
  @HttpCode(202)
  async kick(
    @Auth0Sub() clientId: string,
    @Body() dto: KickDto,
  ): Promise<{ ok: boolean }> {
    this.logger.log(
      `[POST-05] 🥾 KICK recibido | from=${clientId} target=${dto.targetId} room=${dto.roomId}`,
    );

    // (1) Solo el DUEÑO puede expulsar, y no a sí mismo.
    //
    // `clientId` viene del token, así que quien pide el kick es demostrablemente
    // quien dice ser: no alcanza con mandar el `sub` del dueño en el body.
    const isOwner = await this.rooms.isOwner(dto.roomId, clientId);
    if (!isOwner || clientId === dto.targetId) {
      this.logger.warn(
        `[POST-05a] 🚫 KICK RECHAZADO | from=${clientId} NO es el dueño de room=${dto.roomId} (o se auto-expulsa)`,
      );
      return { ok: false };
    }

    // (2) Avisar al expulsado.
    //
    // Si está en ESTA instancia le empujamos el 'kicked' DIRECTO por su Subject
    // local, sin pasar por Redis. Es el camino fiable: el mensaje de Pub/Sub
    // vuelve de forma asíncrona y el dispatch solo entrega a quien siga en el
    // SET, así que el SREM del paso (3) puede ganarle la carrera y el 'kicked'
    // se descartaría — que es justo por qué el botón parecía no hacer nada.
    // Solo publicamos en Redis si el expulsado NO es local (está en otra
    // instancia, y ahí Pub/Sub es la única vía para alcanzarlo).
    const targetSubject = this.registry.getClient(dto.targetId);
    if (targetSubject) {
      this.logger.log(
        `[POST-05b] 📨 'kicked' DIRECTO por el SSE local de ${dto.targetId} (sin pasar por Redis)`,
      );
      targetSubject.next({
        data: {
          type: 'kicked',
          from: clientId,
          to: dto.targetId,
        } as SignalMessage,
      });
    } else {
      this.logger.log(
        `[POST-05b] 📨 ${dto.targetId} no es local → publico 'kicked' en Redis para la instancia que lo tenga`,
      );
      await this.redis.publish(dto.roomId, {
        type: 'kicked',
        from: clientId,
        to: dto.targetId,
      });
    }

    // (3) Ahora sí: sacarlo del SET y avisar al resto que se fue.
    await this.rooms.removeMember(dto.roomId, dto.targetId);
    await this.redis.publish(dto.roomId, {
      type: 'peer-left',
      from: dto.targetId,
    });

    // Si el expulsado está conectado en ESTA instancia, cerramos su SSE acá
    // (si está en otra, esa instancia lo limpiará cuando su navegador llame a
    // /leave al procesar el 'kicked').
    //
    // Pero NO lo cerramos ya: el 'kicked' del paso (2) viaja por Redis y vuelve
    // de forma asíncrona, así que cerrar el Subject ahora mismo mataría el
    // stream ANTES de que el mensaje salga por él y el expulsado nunca se
    // enteraría. Le damos un margen corto para que el round-trip de Pub/Sub
    // complete; si el navegador ya se fue por su cuenta, cerrar de más es
    // inocuo (cleanupLocal es tolerante a que el cliente ya no esté).
    if (this.registry.hasClient(dto.targetId)) {
      this.logger.log(
        `[POST-05c] 🧹 El expulsado ${dto.targetId} es local → cierro su SSE tras dar margen al 'kicked'`,
      );
      setTimeout(() => {
        if (this.registry.hasClient(dto.targetId)) {
          this.cleanupLocal(dto.targetId, dto.roomId);
        }
      }, 1000);
    }

    return { ok: true };
  }

  /**
   * Reservar una sala antes de entrar: `POST /signaling/rooms`.
   *
   * Existe para imponer "un usuario, una sala creada". Sin este paso, la sala
   * nace cuando el primero abre su SSE, y ahí ya es tarde para rechazarla con
   * un mensaje claro — el cliente estaría a mitad de la negociación.
   *
   * Devuelve 409 si el usuario ya tiene una sala creada, con el id de esa sala
   * para que el front pueda ofrecerle volver.
   */
  @Post('rooms')
  @HttpCode(201)
  async createRoom(
    @Auth0Sub() clientId: string,
    @Body() dto: { roomId: string },
  ): Promise<{ roomId: string }> {
    const claimed = await this.rooms.claimCreatedRoom(clientId, dto.roomId);
    if (!claimed) {
      const existing = await this.rooms.getCreatedRoom(clientId);
      this.logger.warn(
        `[POST-07] 🚫 ${clientId} ya tiene la room ${existing} creada → rechazo crear ${dto.roomId}`,
      );
      throw new ConflictException({
        message: 'You already have a room.',
        roomId: existing,
      });
    }
    this.logger.log(`[POST-07] 🆕 ${clientId} creó la room ${dto.roomId}`);
    return { roomId: dto.roomId };
  }

  /**
   * Eliminar una sala: `DELETE /signaling/rooms/:roomId`.
   *
   * Dos condiciones, ambas validadas en el server:
   *  1. Solo el DUEÑO puede eliminarla.
   *  2. Solo si está SOLO en la sala. Eliminar con alguien más adentro sería
   *     cortarle la llamada de golpe; para eso ya existe el kick, que es una
   *     acción distinta y con su propia confirmación.
   */
  @Delete('rooms/:roomId')
  @HttpCode(200)
  async deleteRoom(
    @Auth0Sub() clientId: string,
    @Param('roomId') roomId: string,
  ): Promise<{ ok: true }> {
    const isOwner = await this.rooms.isOwner(roomId, clientId);
    if (!isOwner) {
      this.logger.warn(
        `[DELETE-01] 🚫 ${clientId} NO es dueño de ${roomId} → rechazo el borrado`,
      );
      throw new ForbiddenException('Only the room owner can delete it.');
    }

    const members = await this.rooms.countMembers(roomId);
    if (members > 1) {
      this.logger.warn(
        `[DELETE-01] 🚫 room ${roomId} tiene ${members} miembros → no se puede eliminar`,
      );
      throw new ConflictException(
        'You can only delete the room when nobody else is in it.',
      );
    }

    await this.rooms.deleteRoom(roomId, clientId);
    this.cleanupLocal(clientId, roomId);
    return { ok: true };
  }

  /**
   * Avisar al peer que silencié o reactivé mi micrófono.
   *
   * Se hace por señalización porque el mute del front es `track.enabled =
   * false`: la pista sigue viajando (en silencio) y el SDP no cambia, así que
   * el otro navegador no recibe ningún evento de WebRTC del que enterarse.
   */
  @Post('mute')
  @HttpCode(202)
  async mute(
    @Auth0Sub() clientId: string,
    @Body() dto: MuteDto,
  ): Promise<{ ok: true }> {
    this.logger.log(
      `[POST-06] 🎙️ MUTE ${dto.muted ? 'ON' : 'OFF'} | from=${clientId} room=${dto.roomId}`,
    );
    // Se PERSISTE antes de publicar: el evento avisa a quien está conectado
    // ahora, y el estado en Redis lo hereda quien entre después.
    await this.rooms.setMuted(dto.roomId, clientId, dto.muted);
    await this.redis.publish(dto.roomId, {
      type: 'peer-muted',
      from: clientId,
      payload: { muted: dto.muted },
    });
    return { ok: true };
  }

  /** Colgar explícito: quitar del SET, avisar al peer, limpiar local. */
  @Post('leave')
  @HttpCode(202)
  async leave(
    @Auth0Sub() clientId: string,
    @Body() dto: LeaveDto,
  ): Promise<{ ok: true }> {
    this.logger.log(
      `[POST-04] 👋 LEAVE recibido | from=${clientId} room=${dto.roomId} → lo saco del SET y aviso 'peer-left'`,
    );
    await this.releaseMember(clientId, dto.roomId);
    return { ok: true };
  }

  /**
   * Saca a un cliente de la room: lo quita del SET de Redis, avisa 'peer-left'
   * al canal, traspasa la propiedad si hacía falta y limpia el estado local.
   *
   * Lo comparten el `leave` explícito y el cierre del SSE, porque son el mismo
   * hecho ("este cliente ya no está") por dos caminos distintos.
   */
  private async releaseMember(clientId: string, roomId: string): Promise<void> {
    const { newOwner } = await this.rooms.removeMember(roomId, clientId);
    await this.redis.publish(roomId, { type: 'peer-left', from: clientId });
    // Si se fue el dueño, el que queda hereda la room: hay que avisarle para
    // que su UI muestre el botón de expulsar. Va por Redis porque el nuevo
    // dueño puede estar conectado en OTRA instancia.
    if (newOwner) {
      await this.redis.publish(roomId, {
        type: 'role',
        from: 'server',
        to: newOwner,
        payload: { isOwner: true },
      });
    }
    this.cleanupLocal(clientId, roomId);
  }

  /**
   * Limpieza del estado LOCAL de esta instancia para un cliente:
   *  - quitar su Subject del Map,
   *  - decrementar el ref-count de la room; si llega a 0, desuscribir el canal.
   */
  private cleanupLocal(clientId: string, roomId: string): void {
    const sub = this.registry.getClient(clientId);
    sub?.complete();
    this.registry.removeClient(clientId);
    this.logger.log(
      `[CLEAN-01] 🧹 clientId=${clientId} quitado del Map local de esta instancia`,
    );
    if (this.registry.decrementRoom(roomId)) {
      void this.redis.unsubscribe(roomId);
      this.logger.log(
        `[CLEAN-02] 📡 Era el último cliente local de room=${roomId} → DESUSCRITO del canal Redis room:${roomId}`,
      );
    }
  }
}
