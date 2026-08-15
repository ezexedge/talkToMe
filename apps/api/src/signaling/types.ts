/**
 * Tipos compartidos de la señalización.
 *
 * Un SignalMessage es la unidad que viaja:
 *  - publicada en Redis Pub/Sub (canal `room:{roomId}`), y
 *  - entregada al navegador por SSE.
 *
 * `from` es el clientId que originó el mensaje. Es IMPRESCINDIBLE porque
 * Pub/Sub hace broadcast a todos los suscriptores del canal (incluida la
 * instancia que publicó), así que al recibir filtramos por `from` para no
 * devolverle el mensaje a su propio emisor.
 */
export type SignalType =
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'peer-joined'
  | 'peer-left'
  | 'room-full'
  /**
   * El usuario ya está en OTRA room. Un usuario logueado solo puede estar en
   * una room a la vez, así que se rechaza la entrada y `payload.roomId` dice en
   * cuál está, para que el front pueda ofrecerle volver a ella.
   */
  | 'already-in-room'
  /**
   * Expulsión: el peer que sigue en la room echó al otro. Va DIRIGIDO (`to`)
   * al expulsado, que debe cortar y volver al lobby.
   *
   * A diferencia de `peer-left`, este mensaje SÍ se obedece siempre: no es una
   * suposición sobre si el otro sigue ahí (que WebRTC contradice), es una orden
   * explícita de alguien que está presente. Por eso no se valida contra el
   * estado de la conexión.
   */
  /**
   * Cambio de micrófono del emisor: `payload.muted` dice si quedó silenciado.
   *
   * Va por señalización y no por WebRTC porque silenciar es `track.enabled =
   * false`, que sigue enviando la pista (en silencio) sin tocar el SDP: el otro
   * lado no recibe ningún evento y no tiene forma de enterarse. Renegociar el
   * SDP solo para esto sería mucho más caro y cortaría el audio un instante.
   */
  /**
   * Entró alguien a la sala, dirigido al que YA estaba esperando.
   *
   * Es distinto de `peer-joined`, que significa "sos el initiator, creá la
   * oferta" y va solo al que llega. Si le mandáramos ese al que espera, los dos
   * ofertarían a la vez (glare). Este mensaje es puramente informativo: sirve
   * para que la UI salga de "esperando participante" apenas alguien entra, sin
   * depender de que llegue el audio.
   */
  | 'peer-arrived'
  | 'peer-muted'
  | 'kicked'
  /**
   * Rol del cliente en la room, enviado por el server apenas abre el SSE.
   * `payload.isOwner` indica si ES el dueño (creador) y por tanto si puede
   * expulsar. Se manda también tras un F5, porque el front pierde el dato al
   * recargar y necesita volver a saber si mostrar el botón de expulsar.
   *
   * Es SOLO para la UI: la autorización real del kick la valida el server
   * contra Redis, así que falsear esto en el navegador no habilita nada.
   */
  | 'role'
  /**
   * Latido periódico del server por el SSE. El front lo IGNORA: existe para
   * escribir bytes en el socket y así detectar conexiones muertas que no
   * emitieron evento de cierre (y, del lado del server, para refrescar el TTL
   * de la room en Redis mientras el cliente siga realmente conectado).
   */
  | 'ping';

export interface SignalMessage {
  type: SignalType;
  /** clientId que originó el mensaje. */
  from: string;
  /** clientId destino opcional (p.ej. peer-joined va dirigido a un cliente concreto). */
  to?: string;
  /** SDP, ICE candidate, o lo que aplique según el type. */
  payload?: unknown;
}

export const roomChannel = (roomId: string): string => `room:${roomId}`;
export const roomMembersKey = (roomId: string): string =>
  `room:${roomId}:members`;

/**
 * Marcador de EXISTENCIA de la room, independiente de sus miembros.
 *
 * Hace falta porque en Redis un SET vacío NO existe: cuando sale el último
 * miembro, `room:{id}:members` desaparece solo y la room se esfumaría del
 * lobby al instante. Con esta clave aparte la room sigue "viva" (con 0
 * miembros) durante los 30s de gracia, y su TTL es justo la cuenta regresiva
 * que el front muestra ("se elimina en Ns"). Cuando expira, la room deja de
 * listarse — sin timers ni cron: lo hace Redis.
 */
export const roomAliveKey = (roomId: string): string => `room:${roomId}:alive`;

/**
 * DUEÑO de la room: el clientId del primero que entró (el que la creó).
 * Solo él puede expulsar al otro.
 *
 * Vive en Redis y no en memoria porque la decisión de "¿este puede echar?" la
 * toma la instancia que recibe el POST /kick, que no es necesariamente la
 * misma donde el dueño tiene su SSE abierto.
 *
 * Se fija con SET NX (solo si no existe): así lo gana el PRIMERO en entrar y
 * los siguientes no lo pisan. Comparte el ciclo de vida de la room —si la room
 * expira, esta clave también, y el próximo que la cree será el nuevo dueño.
 */
export const roomOwnerKey = (roomId: string): string => `room:${roomId}:owner`;

/**
 * Room en la que está actualmente un usuario: `user:{auth0Sub}:room` → roomId.
 *
 * Existe para la regla "un usuario logueado solo puede estar en UNA room".
 * Sin esto habría que escanear todos los SET de miembros para saber si alguien
 * ya está en otra room, que es O(nº de rooms) en cada entrada; con esta clave
 * es un solo GET.
 *
 * Va en Redis y no en memoria porque el usuario puede intentar entrar a la
 * segunda room contra una instancia DISTINTA de la que atiende la primera.
 *
 * Comparte el TTL de la room para que un proceso caído no deje al usuario
 * marcado como "ocupado" para siempre.
 */
export const userRoomKey = (auth0Sub: string): string => `user:${auth0Sub}:room`;

/**
 * Sala CREADA por un usuario: `user:{auth0Sub}:createdRoom` → roomId.
 *
 * Distinta de `userRoomKey`, que es "en qué sala estoy ahora". Esta dice "qué
 * sala creé", y sobrevive a que el creador salga: si no, alguien podría crear
 * una sala, irse, y crear otra, dejando salas huérfanas acumuladas.
 *
 * Comparte el ciclo de vida de la sala: se borra cuando la sala se elimina o
 * expira, y ahí el usuario queda libre para crear otra.
 */
export const userCreatedRoomKey = (auth0Sub: string): string =>
  `user:${auth0Sub}:createdRoom`;

/**
 * Estado de un participante DENTRO de una sala: `room:{id}:state:{sub}`.
 *
 * Hash con lo que hoy solo viajaba como evento SSE (`muted`) más metadatos de
 * la sesión (`joinedAt`).
 *
 * POR QUÉ HACE FALTA: los eventos no tienen memoria. Si el otro se silencia y
 * vos entrás DESPUÉS, ese `peer-muted` ya pasó y nunca te llega: lo verías con
 * el micrófono abierto. Con el estado en Redis, al entrar se lee la foto actual
 * de la sala y la UI arranca sincronizada.
 *
 * Va SEPARADO de `user:{sub}:profile` a propósito: nombre y foto son del
 * usuario (globales, sobreviven a la llamada), mientras que el mute pertenece a
 * ESTA sala y debe morir con ella.
 *
 * Y va aparte del SET de miembros porque ese SET sostiene la membresía con
 * operaciones atómicas (SADD/SREM/SCARD) de las que depende el límite de 2;
 * meterle JSON adentro obligaría a leer y reescribir para cada cambio.
 */
export const roomMemberStateKey = (roomId: string, auth0Sub: string): string =>
  `room:${roomId}:state:${auth0Sub}`;
