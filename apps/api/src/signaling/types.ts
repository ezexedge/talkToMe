export type SignalType =
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'peer-joined'
  | 'peer-left'
  | 'room-full'
  | 'already-in-room'
  | 'peer-arrived'
  | 'peer-muted'
  | 'kicked'
  | 'role'
  | 'ping';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to?: string;
  payload?: unknown;
}

export const roomChannel = (roomId: string): string => `room:${roomId}`;
export const roomMembersKey = (roomId: string): string =>
  `room:${roomId}:members`;

export const roomAliveKey = (roomId: string): string => `room:${roomId}:alive`;

export const roomOwnerKey = (roomId: string): string => `room:${roomId}:owner`;

export const userRoomKey = (auth0Sub: string): string =>
  `user:${auth0Sub}:room`;

export const userCreatedRoomKey = (auth0Sub: string): string =>
  `user:${auth0Sub}:createdRoom`;

export const roomMemberStateKey = (roomId: string, auth0Sub: string): string =>
  `room:${roomId}:state:${auth0Sub}`;
