import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { MessageEvent } from '@nestjs/common';

/**
 * LocalSseRegistry — ÚNICO estado en memoria permitido en cada instancia.
 *
 * ¿Por qué es necesario pese a usar Redis?
 * Una conexión SSE abierta es un objeto VIVO en la RAM del proceso de Nest
 * (su `Subject<MessageEvent>`). Redis NO puede empujar bytes al navegador;
 * Redis empuja a la instancia, y la instancia empuja al navegador usando el
 * Subject que tiene en memoria. Por eso cada instancia guarda SOLO los
 * Subjects de SUS PROPIOS clientes conectados. No es estado compartido:
 * la membresía de rooms y el enrutado entre instancias viven en Redis.
 *
 * Además llevamos un contador local de cuántos clientes de ESTA instancia
 * usan cada room, para suscribir/desuscribir el canal Redis exactamente una
 * vez por room por instancia (sub cuando pasa de 0→1, unsub cuando 1→0).
 */
@Injectable()
export class LocalSseRegistry {
  /** clientId -> Subject del SSE de ese cliente (solo clientes de esta instancia). */
  private readonly clients = new Map<string, Subject<MessageEvent>>();

  /** roomId -> nº de clientes locales en esa room (para sub/unsub a Redis). */
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

  /**
   * Incrementa el contador de la room. Devuelve true si es el PRIMER cliente
   * local de esa room (la instancia debe suscribirse al canal Redis).
   */
  incrementRoom(roomId: string): boolean {
    const next = (this.roomRefCounts.get(roomId) ?? 0) + 1;
    this.roomRefCounts.set(roomId, next);
    return next === 1;
  }

  /**
   * Decrementa el contador de la room. Devuelve true si era el ÚLTIMO cliente
   * local de esa room (la instancia debe desuscribirse del canal Redis).
   */
  decrementRoom(roomId: string): boolean {
    const current = this.roomRefCounts.get(roomId) ?? 0;
    if (current <= 1) {
      this.roomRefCounts.delete(roomId);
      return current === 1;
    }
    this.roomRefCounts.set(roomId, current - 1);
    return false;
  }

  /** Cuántos SSE tiene abiertos ESTA instancia (para /health/stats). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Cuántas rooms distintas tiene esta instancia (para /health/stats). */
  get roomCount(): number {
    return this.roomRefCounts.size;
  }

  /**
   * Cierra ordenadamente TODOS los SSE de esta instancia.
   *
   * Se llama al apagar el proceso (SIGTERM en un deploy). Al completar los
   * Subjects, el navegador ve el stream cerrado y `EventSource` reconecta solo
   * —contra otra réplica, porque Nginx ya sacó a esta del upstream—.
   *
   * Sin esto, el proceso muere con los sockets abiertos: el cliente no recibe
   * un cierre limpio y tarda bastante más en darse cuenta, así que cada deploy
   * se siente como un corte de la llamada.
   *
   * No se toca Redis acá: la membresía la limpia el `finalize` de cada stream
   * al completarse, y si algo quedara colgado está el TTL de la sala.
   */
  closeAll(): number {
    const total = this.clients.size;
    this.clients.forEach((subject) => subject.complete());
    this.clients.clear();
    this.roomRefCounts.clear();
    return total;
  }
}
