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

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  private static readonly ROOM_TTL_SECONDS = 120;

  static readonly EMPTY_ROOM_GRACE_SECONDS = 30;

  constructor(private readonly redis: RedisPubSubService) {}

  async addMember(roomId: string, clientId: string): Promise<number> {
    const key = roomMembersKey(roomId);

    // SADD + SCARD in one Lua script: split commands race and both peers
    // end up thinking they are the initiator (or neither does).
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

  async getCurrentRoom(clientId: string): Promise<string | null> {
    return this.redis.commands.get(userRoomKey(clientId));
  }

  async touch(roomId: string, clientId?: string): Promise<void> {
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

  async getOwner(roomId: string): Promise<string | null> {
    return this.redis.commands.get(roomOwnerKey(roomId));
  }

  async initMemberState(roomId: string, clientId: string): Promise<void> {
    const key = roomMemberStateKey(roomId, clientId);
    await this.redis.commands.hset(key, {
      muted: '0',
      joinedAt: String(Date.now()),
    });
    await this.redis.commands.expire(key, RoomsService.ROOM_TTL_SECONDS);
  }

  async setMuted(
    roomId: string,
    clientId: string,
    muted: boolean,
  ): Promise<void> {
    const key = roomMemberStateKey(roomId, clientId);
    await this.redis.commands.hset(key, 'muted', muted ? '1' : '0');
    await this.redis.commands.expire(key, RoomsService.ROOM_TTL_SECONDS);
  }

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

  async getCreatedRoom(clientId: string): Promise<string | null> {
    return this.redis.commands.get(userCreatedRoomKey(clientId));
  }

  async deleteRoom(roomId: string, ownerId: string): Promise<void> {
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
    const created = await this.redis.commands.get(userCreatedRoomKey(ownerId));
    if (created === roomId) {
      await this.redis.commands.del(userCreatedRoomKey(ownerId));
    }
    this.logger.log(
      `[ROOM-06] 🗑️ Room ${roomId} ELIMINADA por su dueño ${ownerId}`,
    );
  }

  async isOwner(roomId: string, clientId: string): Promise<boolean> {
    const owner = await this.getOwner(roomId);
    if (owner !== null) return owner === clientId;
    const created = await this.getCreatedRoom(clientId);
    return created === roomId;
  }

  async removeMember(
    roomId: string,
    clientId: string,
  ): Promise<{ newOwner: string | null }> {
    // Whole teardown in one round-trip: 13 chained commands cost ~400ms on Upstash.
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

    return { newOwner: newOwner || null };
  }

  async countMembers(roomId: string): Promise<number> {
    return this.redis.commands.scard(roomMembersKey(roomId));
  }

  async isMember(roomId: string, clientId: string): Promise<boolean> {
    const res = await this.redis.commands.sismember(
      roomMembersKey(roomId),
      clientId,
    );
    return res === 1;
  }

  async getPeer(roomId: string, clientId: string): Promise<string | null> {
    const members = await this.redis.commands.smembers(roomMembersKey(roomId));
    return members.find((m) => m !== clientId) ?? null;
  }

  async listRooms(): Promise<
    Array<{
      roomId: string;
      count: number;
      expiresInSeconds: number | null;
      members: string[];
      owner: string | null;
    }>
  > {
    const pattern = roomAliveKey('*');
    const found: string[] = [];

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
        const roomId = key.slice('room:'.length, -':alive'.length);
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
          owner,
          expiresInSeconds:
            count === 0 &&
            ttl > 0 &&
            ttl <= RoomsService.EMPTY_ROOM_GRACE_SECONDS
              ? ttl
              : null,
        };
      }),
    );

    return rooms.sort((a, b) => a.roomId.localeCompare(b.roomId));
  }
}
