import { Injectable, Logger } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';
import {
  roomAliveKey,
  roomMembersKey,
  roomMemberStateKey,
  roomOwnerKey,
  userCreatedRoomKey,
  userRoomKey,
} from './types';

/**
 * RoomsService — membresía de rooms 1-a-1 en Redis (NO en memoria).
 *
 * Usa un SET por room: `room:{roomId}:members` con los clientId.
 * Esto es estado compartido entre todas las instancias: cualquier instancia
 * puede contar miembros, conocer al peer, o limpiar al salir.
 *
 * El SET se opera con el cliente de comandos (redisPub) del RedisPubSubService.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  /**
   * TTL de seguridad por si una room queda colgada. Es la ÚLTIMA red: la baja
   * normal la hace el cierre del SSE. Se mantiene corto (2 min) y el heartbeat
   * del SSE lo refresca mientras el cliente siga conectado de verdad; si la
   * instancia se cae de golpe y nadie llega a limpiar, la room se desvanece en
   * minutos en vez de quedar ocupada por un fantasma durante una hora.
   */
  private static readonly ROOM_TTL_SECONDS = 120;

  /**
   * Gracia antes de borrar una room que se quedó SIN miembros.
   * No la borramos al instante: la dejamos existir 30s con 0 miembros para que
   * el lobby pueda mostrarla con la cuenta regresiva "se elimina en Ns" y para
   * que quien se fue por error pueda volver a la misma room. Pasados los 30s,
   * Redis la expira solo (el TTL hace el trabajo, no hace falta un timer).
   */
  static readonly EMPTY_ROOM_GRACE_SECONDS = 30;

  constructor(private readonly redis: RedisPubSubService) {}

  /**
   * Añade un cliente al SET de la room, refresca los TTL y, si la room no tenía
   * dueño, lo declara dueño (es el primero que entra = el creador).
   */
  async addMember(roomId: string, clientId: string): Promise<number> {
    const key = roomMembersKey(roomId);

    /**
     * SADD + SCARD como UNA operación atómica, vía Lua.
     *
     * Con dos comandos separados hay carrera, y de las dos formas:
     *  - SCARD y después SADD → ambos leen 0, ninguno se cree el segundo, nadie
     *    oferta y la llamada nunca arranca.
     *  - SADD y después SCARD → ambos alcanzan a agregarse antes de leer, los
     *    dos leen 2, los DOS se creen initiator y ofertan (glare).
     *
     * Redis ejecuta un script Lua sin intercalar otros comandos, así que cada
     * cliente recibe una posición distinta: exactamente uno obtiene 2 y es el
     * initiator. Es la misma razón por la que el dueño se fija con SET NX.
     */
    const [size, becameOwner] = (await this.redis.commands.eval(
      `
      local membersKey = KEYS[1]
      local aliveKey   = KEYS[2]
      local ownerKey   = KEYS[3]
      local userRoom   = KEYS[4]
      local stateKey   = KEYS[5]
      local clientId   = ARGV[1]
      local roomId     = ARGV[2]
      local ttl        = tonumber(ARGV[3])

      redis.call('SADD', membersKey, clientId)
      local size = redis.call('SCARD', membersKey)
      redis.call('EXPIRE', membersKey, ttl)

      -- La sala vuelve a tener gente → se cancela la cuenta regresiva de
      -- borrado devolviéndole el TTL largo al marcador de existencia.
      redis.call('SET', aliveKey, '1', 'EX', ttl)

      -- DUEÑO con NX: lo gana el PRIMERO que entra y los siguientes no lo
      -- pisan. Dentro del script no hay forma de que dos lo ganen a la vez.
      local becameOwner = 0
      if redis.call('SET', ownerKey, clientId, 'EX', ttl, 'NX') then
        becameOwner = 1
      else
        redis.call('EXPIRE', ownerKey, ttl)
      end

      -- Marca usuario→sala, para la regla de "una sala a la vez".
      redis.call('SET', userRoom, roomId, 'EX', ttl)

      -- Estado inicial del participante: micrófono abierto. Se escribe siempre
      -- (no NX): si salió silenciado y vuelve, el navegador no conserva el
      -- mute, así que arrastrar el valor viejo sería mostrar algo falso.
      redis.call('HSET', stateKey, 'muted', '0', 'joinedAt', ARGV[4])
      redis.call('EXPIRE', stateKey, ttl)

      return { size, becameOwner }
      `,
      5,
      key,
      roomAliveKey(roomId),
      roomOwnerKey(roomId),
      userRoomKey(clientId),
      roomMemberStateKey(roomId, clientId),
      clientId,
      roomId,
      String(RoomsService.ROOM_TTL_SECONDS),
      String(Date.now()),
    )) as [number, number];

    if (becameOwner === 1) {
      this.logger.log(
        `[ROOM-04] 👑 ${clientId} es el DUEÑO de room=${roomId} (primero en entrar)`,
      );
    }
    this.logger.log(
      `[ROOM-01] ➕ SADD ${key} ${clientId} → ahora ${size} miembro(s) (TTL ${RoomsService.ROOM_TTL_SECONDS}s)`,
    );
    return size;
  }

  /**
   * Devuelve la room en la que el usuario ya está, o null si está libre.
   *
   * Se consulta ANTES de dejarlo entrar a una room nueva. Si devuelve la MISMA
   * room a la que quiere entrar, no es un conflicto: es una reconexión (F5) o
   * una segunda pestaña, y ese caso lo resuelve `isMember`.
   */
  async getCurrentRoom(clientId: string): Promise<string | null> {
    return this.redis.commands.get(userRoomKey(clientId));
  }

  /**
   * Refresca los TTL de una room que sigue teniendo gente conectada.
   *
   * Va de la mano del TTL corto: mientras haya un SSE abierto, el heartbeat
   * llama a esto y la room se mantiene viva. Si el proceso muere sin poder
   * limpiar, deja de refrescarse y Redis la expira sola.
   */
  async touch(roomId: string, clientId?: string): Promise<void> {
    // Un solo script Lua en vez de ~6 EXPIRE encadenados: el heartbeat corre
    // cada 20s por cada cliente conectado, así que a escala son muchos viajes
    // a Upstash que se ahorran.
    await this.redis.commands.eval(
      `
      local ttl = tonumber(ARGV[1])
      redis.call('EXPIRE', KEYS[1], ttl)  -- members
      redis.call('EXPIRE', KEYS[2], ttl)  -- alive
      redis.call('EXPIRE', KEYS[3], ttl)  -- owner
      if ARGV[2] ~= '' then
        redis.call('EXPIRE', KEYS[4], ttl)  -- user:{sub}:room
        redis.call('EXPIRE', KEYS[5], ttl)  -- estado del participante
        -- La marca de "sala creada" late solo si apunta a ESTA sala.
        if redis.call('GET', KEYS[6]) == ARGV[3] then
          redis.call('EXPIRE', KEYS[6], ttl)
        end
      end
      return 1
      `,
      6,
      roomMembersKey(roomId),
      roomAliveKey(roomId),
      roomOwnerKey(roomId),
      userRoomKey(clientId ?? 'none'),
      roomMemberStateKey(roomId, clientId ?? 'none'),
      userCreatedRoomKey(clientId ?? 'none'),
      String(RoomsService.ROOM_TTL_SECONDS),
      clientId ?? '',
      roomId,
    );
  }

  /** clientId del dueño de la room, o null si la room no existe. */
  async getOwner(roomId: string): Promise<string | null> {
    return this.redis.commands.get(roomOwnerKey(roomId));
  }

  /**
   * Inicializa el estado de un participante al entrar (micrófono abierto).
   *
   * Se escribe SIEMPRE al entrar, sin `NX`: si el usuario salió estando
   * silenciado y vuelve, tiene el micrófono abierto de nuevo (el navegador no
   * conserva el mute entre sesiones), así que arrastrar el valor viejo sería
   * mostrar algo falso.
   */
  async initMemberState(roomId: string, clientId: string): Promise<void> {
    const key = roomMemberStateKey(roomId, clientId);
    await this.redis.commands.hset(key, {
      muted: '0',
      joinedAt: String(Date.now()),
    });
    await this.redis.commands.expire(key, RoomsService.ROOM_TTL_SECONDS);
  }

  /** Persiste el mute/unmute de un participante. */
  async setMuted(
    roomId: string,
    clientId: string,
    muted: boolean,
  ): Promise<void> {
    const key = roomMemberStateKey(roomId, clientId);
    await this.redis.commands.hset(key, 'muted', muted ? '1' : '0');
    await this.redis.commands.expire(key, RoomsService.ROOM_TTL_SECONDS);
  }

  /**
   * Estado actual de un participante. Se lee al ENTRAR, para que la UI arranque
   * sincronizada en vez de esperar a que el otro cambie algo.
   */
  async getMemberState(
    roomId: string,
    clientId: string,
  ): Promise<{ muted: boolean; joinedAt: number | null }> {
    const hash = await this.redis.commands.hgetall(
      roomMemberStateKey(roomId, clientId),
    );
    return {
      muted: hash?.muted === '1',
      joinedAt: hash?.joinedAt ? Number(hash.joinedAt) : null,
    };
  }

  /**
   * Registra que este usuario creó esta sala. Solo tiene efecto si NO tenía
   * otra creada — devuelve `false` si ya tenía una, y ahí el llamador debe
   * rechazar la creación.
   *
   * Se usa `SET NX` (escribe solo si no existe), que es atómico: dos intentos
   * simultáneos del mismo usuario no pueden ganar los dos.
   */
  async claimCreatedRoom(clientId: string, roomId: string): Promise<boolean> {
    const ok = await this.redis.commands.set(
      userCreatedRoomKey(clientId),
      roomId,
      'EX',
      RoomsService.ROOM_TTL_SECONDS,
      'NX',
    );
    return ok !== null;
  }

  /** Sala que este usuario tiene creada, o null si no tiene ninguna. */
  async getCreatedRoom(clientId: string): Promise<string | null> {
    return this.redis.commands.get(userCreatedRoomKey(clientId));
  }

  /**
   * Elimina la sala por completo: miembros, marcador de existencia, dueño y la
   * marca de "sala creada" del dueño (que queda libre para crear otra).
   *
   * No avisa a nadie por señalización: eso lo hace el controller, que sabe a
   * quién notificar.
   */
  async deleteRoom(roomId: string, ownerId: string): Promise<void> {
    // Los hashes de estado de cada participante se borran por patrón: son
    // claves por usuario y no hay una lista de ellas.
    const states = await this.redis.commands.keys(
      roomMemberStateKey(roomId, '*'),
    );
    if (states.length) await this.redis.commands.del(...states);
    await this.redis.commands.del(
      roomMembersKey(roomId),
      roomAliveKey(roomId),
      roomOwnerKey(roomId),
      userRoomKey(ownerId),
    );
    // Solo se libera la marca de creación si apunta a ESTA sala: si el usuario
    // ya creó otra, borrarla sin mirar lo dejaría con dos.
    const created = await this.redis.commands.get(userCreatedRoomKey(ownerId));
    if (created === roomId) {
      await this.redis.commands.del(userCreatedRoomKey(ownerId));
    }
    this.logger.log(`[ROOM-06] 🗑️ Room ${roomId} ELIMINADA por su dueño ${ownerId}`);
  }

  /**
   * ¿Este cliente es el dueño (creador) de la room?
   *
   * Mira DOS fuentes, y hace falta:
   *  - `room:{id}:owner` — quién manda mientras hay gente adentro. Se traspasa
   *    si el dueño se va y queda alguien.
   *  - `user:{sub}:createdRoom` — quién la creó. Sobrevive a que la sala quede
   *    vacía, momento en el que la clave `owner` ya expiró.
   *
   * Sin la segunda, el creador de una sala vacía no podría borrar su propia
   * sala: la única condición bajo la cual el borrado está permitido.
   */
  async isOwner(roomId: string, clientId: string): Promise<boolean> {
    const owner = await this.getOwner(roomId);
    if (owner !== null) return owner === clientId;
    const created = await this.getCreatedRoom(clientId);
    return created === roomId;
  }

  /**
   * Quita un cliente del SET. Si la room queda vacía NO la borramos al instante:
   * le ponemos al marcador de existencia un TTL corto (30s) para que el lobby
   * la siga mostrando en 0/2 con la cuenta regresiva. Si nadie entra, Redis la
   * expira sola; si alguien entra, `addMember` restaura el TTL largo.
   *
   * Si el que se va era el DUEÑO y queda alguien, la propiedad se TRASPASA al
   * que queda. Si no, la room se quedaría con un dueño ausente y el que sigue
   * adentro no podría expulsar nunca a nadie.
   *
   * Devuelve el nuevo dueño si hubo traspaso (para avisarle por SSE), o null.
   */
  async removeMember(
    roomId: string,
    clientId: string,
  ): Promise<{ newOwner: string | null }> {
    /**
     * TODA la baja en UN script Lua = UN solo round-trip a Redis.
     *
     * Antes eran ~13 comandos encadenados, cada uno esperando al anterior. Con
     * Upstash a ~40ms por comando, colgar tardaba ~400ms y se notaba como una
     * demora al volver al lobby. Acá la lógica corre DENTRO de Redis y se paga
     * un solo viaje.
     *
     * Efecto secundario valioso: al ser atómico, desaparecen las carreras entre
     * dos bajas simultáneas (p.ej. el traspaso de propiedad leyendo un SET que
     * otro está modificando).
     *
     * Devuelve [remaining, newOwner].
     */
    const [remaining, newOwner] = (await this.redis.commands.eval(
      `
      local membersKey = KEYS[1]
      local stateKey   = KEYS[2]
      local userRoom   = KEYS[3]
      local ownerKey   = KEYS[4]
      local aliveKey   = KEYS[5]
      local clientId   = ARGV[1]
      local roomId     = ARGV[2]
      local grace      = tonumber(ARGV[3])

      redis.call('SREM', membersKey, clientId)
      redis.call('DEL', stateKey)

      -- Liberar al usuario SOLO si su marca apunta a esta sala: si ya entró a
      -- otra, borrarla lo dejaría "libre" estando conectado en la nueva.
      if redis.call('GET', userRoom) == roomId then
        redis.call('DEL', userRoom)
      end

      local remaining = redis.call('SCARD', membersKey)
      local newOwner = ''

      if remaining > 0 then
        -- Traspaso de propiedad: si el que se fue era el dueño, hereda el que
        -- queda. Si no, la sala tendría un dueño ausente y nadie podría
        -- expulsar ni borrarla.
        if redis.call('GET', ownerKey) == clientId then
          local survivors = redis.call('SMEMBERS', membersKey)
          if survivors[1] then
            newOwner = survivors[1]
            redis.call('SET', ownerKey, newOwner, 'EX', ARGV[4])
          end
        end
      else
        -- Sala vacía: se libera al creador (para que pueda crear otra) y se
        -- arranca la cuenta regresiva de borrado.
        local owner = redis.call('GET', ownerKey)
        if owner then
          local createdKey = 'user:' .. owner .. ':createdRoom'
          if redis.call('GET', createdKey) == roomId then
            redis.call('EXPIRE', createdKey, grace)
          end
        end
        redis.call('DEL', membersKey)
        redis.call('EXPIRE', aliveKey, grace)
        redis.call('EXPIRE', ownerKey, grace)
      end

      return { remaining, newOwner }
      `,
      5,
      roomMembersKey(roomId),
      roomMemberStateKey(roomId, clientId),
      userRoomKey(clientId),
      roomOwnerKey(roomId),
      roomAliveKey(roomId),
      clientId,
      roomId,
      String(RoomsService.EMPTY_ROOM_GRACE_SECONDS),
      String(RoomsService.ROOM_TTL_SECONDS),
    )) as [number, string];

    this.logger.log(
      `[ROOM-02] ➖ SREM ${roomMembersKey(roomId)} ${clientId} (quedan ${remaining})`,
    );
    if (newOwner) {
      this.logger.log(
        `[ROOM-05] 👑 El dueño ${clientId} se fue → propiedad TRASPASADA a ${newOwner} en room=${roomId}`,
      );
    }
    if (remaining === 0) {
      this.logger.log(
        `[ROOM-03] ⏳ Room ${roomId} vacía → se elimina en ${RoomsService.EMPTY_ROOM_GRACE_SECONDS}s`,
      );
    }

    // Lua no tiene nil en arrays: el "sin nuevo dueño" viaja como cadena vacía.
    return { newOwner: newOwner || null };
  }

  /** Cuenta los miembros actuales del SET (para el límite de 2). */
  async countMembers(roomId: string): Promise<number> {
    return this.redis.commands.scard(roomMembersKey(roomId));
  }

  /**
   * ¿Este clientId YA es miembro de la room? Sirve para distinguir una
   * RECONEXIÓN (p.ej. F5: el navegador vuelve con el mismo clientId persistido
   * y su id sigue en el SET porque no hizo `leave`) de un cliente nuevo. En la
   * reconexión NO se aplica el límite de 2 ni se re-añade.
   */
  async isMember(roomId: string, clientId: string): Promise<boolean> {
    const res = await this.redis.commands.sismember(
      roomMembersKey(roomId),
      clientId,
    );
    return res === 1;
  }

  /** Devuelve el otro miembro de la room (el peer), o null si no hay. */
  async getPeer(roomId: string, clientId: string): Promise<string | null> {
    const members = await this.redis.commands.smembers(roomMembersKey(roomId));
    return members.find((m) => m !== clientId) ?? null;
  }

  /**
   * Lista todas las rooms activas en Redis con su nº de miembros.
   *
   * Escanea las claves `room:*:alive` (NO `:members`): el SET de miembros
   * desaparece de Redis en cuanto sale el último cliente, así que scanearlo
   * haría desaparecer la room del lobby al instante. El marcador `:alive`
   * sobrevive los 30s de gracia, y su TTL restante es la cuenta regresiva.
   *
   * Devuelve `expiresInSeconds` solo para las rooms vacías (las que están en
   * cuenta regresiva); en las que tienen gente es null.
   */
  async listRooms(): Promise<
    Array<{
      roomId: string;
      count: number;
      expiresInSeconds: number | null;
      /** Los `sub` de Auth0 de quienes están adentro (para pintar avatares). */
      members: string[];
      /** `sub` del dueño de la sala, o null si ya no tiene. */
      owner: string | null;
    }>
  > {
    const pattern = roomAliveKey('*'); // "room:*:alive"
    const found: string[] = [];

    // SCAN con cursor hasta volver a "0".
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.commands.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      found.push(...keys);
    } while (cursor !== '0');

    const rooms = await Promise.all(
      found.map(async (key) => {
        // key = "room:{roomId}:alive" → extraer roomId.
        const roomId = key.slice('room:'.length, -':alive'.length);
        // SMEMBERS en vez de SCARD: necesitamos los ids para resolver los
        // avatares, y el count sale de la misma lectura (las rooms son de 2, no
        // hay riesgo de traer un set grande).
        // Las tres lecturas de esta sala en UN pipeline (un solo round-trip)
        // en vez de tres esperas encadenadas de ~40ms cada una.
        const [[, members], [, ttl], [, owner]] = (await this.redis.commands
          .pipeline()
          .smembers(roomMembersKey(roomId))
          .ttl(key)
          .get(roomOwnerKey(roomId))
          .exec()) as [
          [Error | null, string[]],
          [Error | null, number],
          [Error | null, string | null],
        ];
        const count = members.length;
        return {
          roomId,
          count,
          members,
          /** `sub` del dueño, para que el front muestre "Delete" solo a él. */
          owner,
          // Solo tiene sentido mostrar el countdown si la room está vacía y el
          // TTL es corto (el TTL largo de 1h no es una cuenta regresiva de borrado).
          expiresInSeconds:
            count === 0 && ttl > 0 && ttl <= RoomsService.EMPTY_ROOM_GRACE_SECONDS
              ? ttl
              : null,
        };
      }),
    );

    return rooms.sort((a, b) => a.roomId.localeCompare(b.roomId));
  }
}
