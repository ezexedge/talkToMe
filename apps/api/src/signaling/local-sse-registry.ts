import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { MessageEvent } from '@nestjs/common';

@Injectable()
// The only in-RAM state: SSE sockets can't be shared across instances.
// Everything else (room membership, peer state) lives in Redis.
export class LocalSseRegistry {
  private readonly clients = new Map<string, Subject<MessageEvent>>();

  private readonly roomRefCounts = new Map<string, number>();

  addClient(clientId: string, subject: Subject<MessageEvent>): void {
    this.clients.set(clientId, subject);
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  getClient(clientId: string): Subject<MessageEvent> | undefined {
    return this.clients.get(clientId);
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  incrementRoom(roomId: string): boolean {
    const next = (this.roomRefCounts.get(roomId) ?? 0) + 1;
    this.roomRefCounts.set(roomId, next);
    return next === 1;
  }

  decrementRoom(roomId: string): boolean {
    const current = this.roomRefCounts.get(roomId) ?? 0;
    if (current <= 1) {
      this.roomRefCounts.delete(roomId);
      return current === 1;
    }
    this.roomRefCounts.set(roomId, current - 1);
    return false;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get roomCount(): number {
    return this.roomRefCounts.size;
  }

  closeAll(): number {
    const total = this.clients.size;
    this.clients.forEach((subject) => subject.complete());
    this.clients.clear();
    this.roomRefCounts.clear();
    return total;
  }
}
