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
  targetId: string;
}

@Controller('signaling')
@UseGuards(JwtAuthGuard)
export class SignalingController {
  private readonly logger = new Logger(SignalingController.name);

  private static readonly HEARTBEAT_MS = 20_000;

  constructor(
    private readonly registry: LocalSseRegistry,
    private readonly rooms: RoomsService,
    private readonly redis: RedisPubSubService,
    private readonly userCache: UserCacheService,
    private readonly jwtVerifier: JwtVerifierService,
  ) {}

  @Public()
  @Get('rooms')
  async listRooms(@Req() req: Request): Promise<
    Array<{
      roomId: string;
      count: number;
      expiresInSeconds: number | null;
      members: PublicProfile[];
      isOwner: boolean;
    }>
  > {
    const rooms = await this.rooms.listRooms();

    const viewerSub = await this.viewerSub(req);
    if (!viewerSub) {
      return rooms.map(({ roomId, count, expiresInSeconds }) => ({
        roomId,
        count,
        expiresInSeconds,
        members: [],
        isOwner: false,
      }));
    }

    const allSubs = rooms.flatMap((r) => r.members);
    const profiles = await this.userCache.getMany(allSubs);

    return rooms.map(({ roomId, count, expiresInSeconds, members, owner }) => ({
      roomId,
      count,
      expiresInSeconds,
      members: members.map(
        (sub) => profiles.get(sub) ?? { sub, name: null, picture: null },
      ),
      isOwner: owner !== null && owner === viewerSub,
    }));
  }

  private async viewerSub(req: Request): Promise<string | null> {
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

  @Sse('stream')
  stream(
    @Auth0Sub() clientId: string,
    @Query('roomId') roomId: string,
  ): Observable<MessageEvent> {
    this.logger.log(
      `[SSE-01] 🔌 Cliente abre stream SSE | clientId=${clientId} room=${roomId}`,
    );
    const subject = new Subject<MessageEvent>();

    this.registry.addClient(clientId, subject);
    this.logger.log(
      `[SSE-02] 📥 Subject guardado en Map local de esta instancia | clientId=${clientId}`,
    );

    void this.onClientConnect(clientId, roomId, subject).catch((e) => {
      this.logger.error(
        `[SSE-FATAL] ❌ onClientConnect falló | clientId=${clientId} room=${roomId}: ${(e as Error)?.stack ?? e}`,
      );
    });

    const beat = setInterval(() => {
      void this.rooms.touch(roomId, clientId);
      subject.next({ data: { type: 'ping', from: 'server' } as SignalMessage });
    }, SignalingController.HEARTBEAT_MS);

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

      const alreadyMember = await this.rooms.isMember(roomId, clientId);
      this.logger.log(
        `[SSE-04] 🔢 Abriendo stream en room=${roomId} | ¿este id ya estaba? ${alreadyMember}`,
      );

      if (alreadyMember) {
        this.logger.log(
          `[SSE-04c] ♻️ ${clientId} seguía en el SET (baja aún no aplicada) → lo saco antes de re-entrar`,
        );
        await this.rooms.removeMember(roomId, clientId);
      }

      const count = await this.rooms.countMembers(roomId);

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

      if (count >= 2) {
        this.logger.warn(
          `[SSE-05] 🚫 Room LLENA (2/2) | clientId=${clientId} → envío 'room-full' y cierro su SSE`,
        );
        subject.next({
          data: { type: 'room-full', from: 'server' } as SignalMessage,
        });
        this.cleanupLocal(clientId, roomId);
        subject.complete();
        return;
      }

      const size = await this.rooms.addMember(roomId, clientId);
      this.logger.log(
        `[SSE-06] ✅ clientId=${clientId} AÑADIDO al SET de room=${roomId} (ahora ${size}/2)`,
      );

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

      await this.sendRole(subject, roomId, clientId);

      if (size === 2) {
        this.logger.log(
          `[SSE-07] 👑 clientId=${clientId} es el SEGUNDO en entrar → es INITIATOR. Le envío 'peer-joined' directo por su SSE local para que cree la oferta`,
        );
        subject.next({
          data: {
            type: 'peer-joined',
            from: 'server',
            to: clientId,
          } as SignalMessage,
        });

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
      this.logger.error(
        `[SSE-ERR] ❌ onClientConnect: ${(e as Error).message}`,
      );
      subject.error(e);
    }
  }

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

  @Post('kick')
  @HttpCode(202)
  async kick(
    @Auth0Sub() clientId: string,
    @Body() dto: KickDto,
  ): Promise<{ ok: boolean }> {
    this.logger.log(
      `[POST-05] 🥾 KICK recibido | from=${clientId} target=${dto.targetId} room=${dto.roomId}`,
    );

    const isOwner = await this.rooms.isOwner(dto.roomId, clientId);
    if (!isOwner || clientId === dto.targetId) {
      this.logger.warn(
        `[POST-05a] 🚫 KICK RECHAZADO | from=${clientId} NO es el dueño de room=${dto.roomId} (o se auto-expulsa)`,
      );
      return { ok: false };
    }

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

    await this.rooms.removeMember(dto.roomId, dto.targetId);
    await this.redis.publish(dto.roomId, {
      type: 'peer-left',
      from: dto.targetId,
    });

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

  @Post('mute')
  @HttpCode(202)
  async mute(
    @Auth0Sub() clientId: string,
    @Body() dto: MuteDto,
  ): Promise<{ ok: true }> {
    this.logger.log(
      `[POST-06] 🎙️ MUTE ${dto.muted ? 'ON' : 'OFF'} | from=${clientId} room=${dto.roomId}`,
    );
    await this.rooms.setMuted(dto.roomId, clientId, dto.muted);
    await this.redis.publish(dto.roomId, {
      type: 'peer-muted',
      from: clientId,
      payload: { muted: dto.muted },
    });
    return { ok: true };
  }

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

  private async releaseMember(clientId: string, roomId: string): Promise<void> {
    const { newOwner } = await this.rooms.removeMember(roomId, clientId);
    await this.redis.publish(roomId, { type: 'peer-left', from: clientId });
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
