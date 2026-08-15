import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';

/**
 * useAudioCall — encapsula TODA la lógica de una llamada de solo audio 1-a-1.
 *
 * Transporte (3 capas, no se reemplazan entre sí):
 *  - Navegador → API: HTTP POST (offer/answer/ice/leave).
 *  - API → Navegador: SSE (EventSource).
 *  - Navegador ↔ Navegador: WebRTC (el audio directo).
 *
 * Sobre el ORDEN del handshake SDP/ICE:
 *  - El SEGUNDO en entrar a la room es el initiator (lo decide el server con
 *    `peer-joined` dirigido). El initiator crea la OFERTA. Hacer initiator al
 *    segundo evita "glare" (que ambos ofrezcan a la vez).
 *  - offer → setRemoteDescription → createAnswer → setLocalDescription → POST answer.
 *  - answer → setRemoteDescription.
 *  - Los ICE candidates fluyen en paralelo apenas hay localDescription; los que
 *    llegan antes de tener remoteDescription se encolan (pendingIce) y se aplican
 *    después, porque addIceCandidate falla sin descripción remota.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const STUN = 'stun:stun.l.google.com:19302';

/** Log con prefijo común para filtrar fácil en la consola del navegador (filtrá por "CALL"). */
const log = (...args: unknown[]) =>
  console.log('%c[CALL]', 'color:#7c3aed;font-weight:bold', ...args);

/**
 * IDENTIDAD: el clientId es el `sub` de Auth0, NO un UUID por pestaña.
 *
 * Antes se generaba un `crypto.randomUUID()` y se guardaba en sessionStorage
 * para sobrevivir al F5. Ya no hace falta y además sería incorrecto:
 *
 *  - Sobrevivir al F5 sale gratis: el `sub` es el mismo usuario siempre, así
 *    que al recargar el server lo reconoce como miembro del SET y entra por la
 *    rama de RECONEXIÓN (renegocia WebRTC, que es lo único que se perdió).
 *  - Un usuario solo puede estar en UNA room y ocupar UN lugar. Con un id por
 *    pestaña, abrir dos pestañas te dejaba ocupando los dos lugares de la room
 *    hablando con vos mismo. Con el `sub`, la segunda pestaña es una
 *    reconexión de la misma persona.
 *
 * Además el front ya NO manda el clientId: el server lo saca del token que
 * verifica. Mandarlo sería inútil (lo ignora) e inseguro (permitiría
 * suplantar a otro).
 */

export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'room-full'
  /** Ya estás en otra room: un usuario logueado solo puede estar en una. */
  | 'already-in-room'
  | 'error';

interface SignalMessage {
  type:
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
    | 'role';
  from: string;
  to?: string;
  payload?: unknown;
}

export function useAudioCall(roomId: string) {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // true cuando ya hay un peer del otro lado (llegó su audio). Mientras es
  // false y estamos conectados al server, mostramos "esperando participante".
  const [peerConnected, setPeerConnected] = useState(false);
  // clientId del otro participante. Lo aprendemos del `from` de cualquier
  // mensaje suyo que baje por SSE (offer/answer/ice vienen firmados con su id).
  // Hace falta para poder expulsarlo: el POST /kick necesita su targetId.
  const [peerId, setPeerId] = useState<string | null>(null);
  // true si NOS expulsaron (para que la UI lo distinga de un colgado normal).
  const [kicked, setKicked] = useState(false);
  // ¿Somos el DUEÑO (creador) de la room? Lo dice el server al abrir el SSE
  // (type 'role'), y puede cambiar en vivo si el dueño se va y heredamos.
  // Solo sirve para mostrar/ocultar el botón de expulsar: el permiso real lo
  // revalida el server en cada POST /kick contra Redis.
  const [isOwner, setIsOwner] = useState(false);
  // ¿El OTRO tiene el micrófono silenciado? Lo avisa por señalización: el mute
  // es `track.enabled = false`, que no altera el SDP ni emite eventos WebRTC.
  const [peerMuted, setPeerMuted] = useState(false);

  // Identidad y token, de Auth0.
  const { user, getAccessTokenSilently, isAuthenticated } = useAuth0();

  // El clientId ES el `sub` de Auth0 (ver nota de IDENTIDAD arriba). Se guarda
  // en un ref para que los callbacks lo lean sin recrearse, y porque hangup()
  // lo limpia como señal de "ya colgué" (guarda de idempotencia).
  const clientIdRef = useRef<string>('');
  // Se asigna en un effect y no en el render: escribir un ref durante el render
  // es un side-effect (React puede descartar o repetir ese render).
  useEffect(() => {
    if (user?.sub) clientIdRef.current = user.sub;
  }, [user?.sub]);

  /**
   * Devuelve un access token fresco para llamar al API.
   *
   * `getAccessTokenSilently` lo cachea y lo renueva solo cuando está por
   * vencer, así que se puede llamar antes de cada request sin costo de red.
   * Pedirlo en cada llamada (y no guardarlo una vez) evita el caso de un token
   * vencido a mitad de una llamada larga.
   */
  const getToken = useCallback(async (): Promise<string> => {
    return getAccessTokenSilently();
  }, [getAccessTokenSilently]);

  // Nº del intento de unión vigente (ver join()). Sirve para descartar los
  // pasos asíncronos de un intento que ya quedó obsoleto.
  const joinAttemptRef = useRef(0);

  // Bandera de "ya colgué", para que hangup() sea idempotente (se llama tanto
  // desde el botón como desde el cleanup del effect al desmontar).
  const leftRef = useRef(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // ICE recibido antes de tener remoteDescription: se encola y se aplica luego.
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const hasRemoteDescRef = useRef(false);

  // Timer de confirmación de un `peer-left` que llegó con WebRTC aún conectado
  // (ver el caso 'peer-left'). Se guarda para poder cancelarlo si el peer se
  // manifiesta antes de que venza.
  const peerLeftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Último `bytesReceived` de audio, para detectar si el peer sigue emitiendo.
  const lastBytesRef = useRef(0);

  /**
   * ¿Sigue llegando audio del peer?
   *
   * Compara los bytes recibidos contra la última medición: si no crecieron, el
   * otro lado dejó de transmitir. Es la señal más temprana de que alguien se
   * fue —mucho antes de que `connectionState` pase a 'disconnected', que puede
   * tardar decenas de segundos.
   */
  const isStillReceivingAudio = useCallback(async (): Promise<boolean> => {
    const pc = pcRef.current;
    if (!pc) return false;
    try {
      const stats = await pc.getStats();
      let bytes = 0;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          bytes = (report as RTCInboundRtpStreamStats).bytesReceived ?? 0;
        }
      });
      const grew = bytes > lastBytesRef.current;
      lastBytesRef.current = bytes;
      return grew;
    } catch {
      // Si no se pueden leer las estadísticas, no bloqueamos la salida: se
      // asume que no hay audio y se confirma la desconexión.
      return false;
    }
  }, []);

  /** Marca al peer como ido y limpia su estado. */
  const markPeerGone = useCallback(() => {
    setPeerConnected(false);
    setPeerId(null);
    // Si el otro se fue, su estado de micrófono deja de tener sentido: sin esto
    // el próximo que entre heredaría el icono de "silenciado" del anterior.
    setPeerMuted(false);
    setStatus('disconnected');
    setError('The other participant left the room.');
  }, []);

  // hangup() se define más abajo, pero handleSignal lo necesita para el caso
  // 'kicked'. Este ref rompe el ciclo de dependencias entre los dos callbacks
  // (handleSignal → hangup → post → …) sin recrearlos en cada render.
  const hangupRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Puntero SIEMPRE actualizado a handleSignal.
   *
   * `es.onmessage` se asigna UNA sola vez dentro de join(), así que se queda con
   * la versión de handleSignal que existía en ese instante (stale closure).
   * handleSignal se recrea cuando cambian peerId / isOwner, y esa versión nueva
   * nunca llegaba al EventSource: los mensajes se seguían procesando con el
   * closure viejo (peerId = null, isOwner = false). Por eso el 'kicked' no
   * expulsaba a nadie. Con este ref, onmessage delega siempre en la última.
   */
  const handleSignalRef = useRef<((msg: SignalMessage) => void) | null>(null);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      log(`[FRONT-POST] ⬆️ POST /signaling/${path}`, body);
      // El token va en el header (los POST sí lo permiten; el SSE no).
      const token = await getToken();
      await fetch(`${API_URL}/signaling/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    },
    [getToken],
  );

  const createPeerConnection = useCallback(() => {
    log('[FRONT-04] 🎛️ Creando RTCPeerConnection (STUN:', STUN, ')');
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });

    // Agregar nuestras pistas de audio locales.
    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current as MediaStream);
      log('[FRONT-05] 🎙️ Pista de audio local agregada al PeerConnection');
    });

    // ICE local → enviarlo al peer vía POST.
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        log('[FRONT-ICE-OUT] 🧊 ICE local generado → lo mando al peer');
        void post('ice-candidate', {
          roomId,
          candidate: ev.candidate.toJSON(),
        });
      } else {
        log('[FRONT-ICE-OUT] 🧊 Fin de candidatos ICE locales (null)');
      }
    };

    // Audio remoto → reproducir. Si llega audio, hay un peer del otro lado.
    pc.ontrack = (ev) => {
      log('[FRONT-TRACK] 🔊 ¡Llegó AUDIO REMOTO! Lo enchufo al <audio>. Ya hay peer.');
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = ev.streams[0];
      }
      setPeerConnected(true);
    };

    pc.onconnectionstatechange = () => {
      log('[FRONT-PC] connectionState =', pc.connectionState);
      if (pc.connectionState === 'connected') setStatus('connected');
      if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'closed'
      ) {
        setStatus('disconnected');
      }
    };

    pc.oniceconnectionstatechange = () => {
      log('[FRONT-PC] iceConnectionState =', pc.iceConnectionState);
    };

    pcRef.current = pc;
    return pc;
  }, [post, roomId]);

  const flushPendingIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const n = pendingIceRef.current.length;
    if (n > 0) {
      log(`[FRONT-ICE-FLUSH] 🧊 Aplicando ${n} ICE que estaban en cola (ya tengo descripción remota)`);
    }
    for (const cand of pendingIceRef.current) {
      try {
        await pc.addIceCandidate(cand);
      } catch {
        /* candidato inválido/tardío: ignorar */
      }
    }
    pendingIceRef.current = [];
  }, []);

  const handleSignal = useCallback(
    async (msg: SignalMessage) => {
      const pc = pcRef.current;
      log(`[FRONT-SSE-IN] ⬇️ Bajó por SSE: type=${msg.type} from=${msg.from} (pc listo? ${!!pc})`);

      // Aprender el id del peer: cualquier mensaje que no venga del 'server'
      // ni de nosotros mismos viene firmado con el clientId del otro.
      if (msg.from && msg.from !== 'server' && msg.from !== clientIdRef.current) {
        setPeerId(msg.from);
      }

      switch (msg.type) {
        case 'room-full':
          log('[FRONT-06] 🚫 Room llena → no me puedo unir, cierro SSE');
          setStatus('room-full');
          setError('This room already has 2 participants.');
          esRef.current?.close();
          break;

        case 'already-in-room': {
          // Un usuario logueado solo puede estar en UNA room. El server dice en
          // cuál está para que la UI pueda ofrecer volver a ella.
          const other = (msg.payload as { roomId?: string })?.roomId;
          log(`[FRONT-06b] 🚫 Ya estoy en la room ${other} → no puedo entrar a esta`);
          setStatus('already-in-room');
          setError(
            other
              ? `You are already in room "${other}". Leave it before joining another.`
              : 'You are already in another room.',
          );
          esRef.current?.close();
          break;
        }

        case 'peer-joined': {
          // Soy el initiator (el server me dirigió este mensaje).
          //
          // Se ARRANCA DE CERO con un PeerConnection nuevo, en vez de reusar el
          // que haya. Dos motivos, y los dos se veían como "entro, salgo,
          // vuelvo y no nos vemos":
          //  - El `pc` de la variable local está capturado del inicio de
          //    handleSignal y puede ser null o estar cerrado; con null este
          //    handler hacía `return` y NUNCA se enviaba la oferta.
          //  - Si el pc ya había negociado antes, `createOffer` produce una
          //    renegociación que el otro lado —que sí empieza limpio— no puede
          //    casar.
          log('[FRONT-07] 👑 Soy INITIATOR → PeerConnection nuevo → createOffer');
          pcRef.current?.close();
          hasRemoteDescRef.current = false;
          pendingIceRef.current = [];
          lastBytesRef.current = 0;
          const fresh = createPeerConnection();

          const offer = await fresh.createOffer();
          await fresh.setLocalDescription(offer);
          await post('offer', {
            roomId,
            sdp: offer,
          });
          log('[FRONT-08] ✅ Offer creada y enviada');
          break;
        }

        case 'offer': {
          // Igual que en 'peer-joined': se responde con un PeerConnection
          // limpio si el actual ya negoció o quedó inutilizable. Reusar uno con
          // sesión previa hace fallar `setRemoteDescription`, y ahí el que
          // ofertó se queda esperando una answer que nunca llega.
          const current = pcRef.current;
          const needsFresh =
            !current ||
            current.connectionState === 'failed' ||
            current.connectionState === 'closed' ||
            current.signalingState === 'closed' ||
            hasRemoteDescRef.current; // ya había una sesión negociada

          let target = current;
          if (needsFresh) {
            log('[FRONT-09a] ♻️ PeerConnection nuevo para atender esta oferta');
            current?.close();
            hasRemoteDescRef.current = false;
            pendingIceRef.current = [];
            lastBytesRef.current = 0;
            target = createPeerConnection();
          }
          if (!target) return;

          log('[FRONT-09] 📥 Recibí OFFER → setRemoteDescription → createAnswer → POST answer');
          await target.setRemoteDescription(
            msg.payload as RTCSessionDescriptionInit,
          );
          hasRemoteDescRef.current = true;
          await flushPendingIce();
          const answer = await target.createAnswer();
          await target.setLocalDescription(answer);
          await post('answer', {
            roomId,
            sdp: answer,
          });
          log('[FRONT-10] ✅ Answer creada y enviada');
          break;
        }

        case 'answer': {
          // Del ref, no de la variable capturada al entrar a handleSignal: si
          // 'peer-joined' creó un PeerConnection nuevo hace un instante, `pc`
          // apunta al viejo y la answer se aplicaría sobre el equivocado.
          const active = pcRef.current;
          if (!active) return;
          log('[FRONT-11] 📥 Recibí ANSWER → setRemoteDescription (SDP negociado en ambos lados)');
          await active.setRemoteDescription(
            msg.payload as RTCSessionDescriptionInit,
          );
          hasRemoteDescRef.current = true;
          await flushPendingIce();
          break;
        }

        case 'ice-candidate': {
          const cand = msg.payload as RTCIceCandidateInit;
          // También por ref, por el mismo motivo que 'answer'.
          const target = pcRef.current;
          if (!target || !hasRemoteDescRef.current) {
            // Aún no hay descripción remota → encolar.
            log('[FRONT-ICE-IN] 🧊 ICE remoto llegó ANTES de tener descripción remota → lo ENCOLO');
            pendingIceRef.current.push(cand);
          } else {
            log('[FRONT-ICE-IN] 🧊 ICE remoto → addIceCandidate (aplicado ya)');
            try {
              await target.addIceCandidate(cand);
            } catch {
              /* ignorar candidato inválido */
            }
          }
          break;
        }

        case 'peer-left': {
          // VALIDACIÓN: no creerle ciegamente al peer-left.
          // El peer-left es solo SEÑALIZACIÓN. Pero el audio va por WebRTC,
          // directo entre navegadores, y NO se entera de la señalización. Un
          // peer-left puede ser FALSO (p.ej. el otro cambió de pestaña en el
          // móvil y el navegador disparó un beforeunload de más) mientras el
          // audio sigue perfectamente vivo. La fuente de verdad de si el otro
          // sigue ahí es el estado de la conexión WebRTC, NO la señalización.
          const alive =
            pc &&
            (pc.connectionState === 'connected' ||
              pc.iceConnectionState === 'connected' ||
              pc.iceConnectionState === 'completed');

          if (!alive) {
            log('[FRONT-12] 👋 peer-left y WebRTC NO está conectado → desconectado real');
            markPeerGone();
            break;
          }

          // WebRTC todavía se cree conectado, pero eso NO prueba que el otro
          // siga ahí: cuando alguien cierra la pestaña, el navegador tarda
          // DECENAS de segundos en degradar el estado por timeout de ICE. Si
          // nos quedáramos solo con el estado de la conexión, seguirías viendo
          // a alguien que ya se fue durante todo ese rato — que es justo el bug.
          //
          // Tampoco se puede obedecer el peer-left a ciegas: existen falsos
          // positivos (cambiar de pestaña en el móvil puede disparar un leave
          // de más) y ahí cortaríamos una llamada que sigue viva.
          //
          // Solución: darle un plazo corto para desmentirse. Si el peer sigue
          // realmente conectado, su audio va a mantener la conexión sana y
          // volverá a llegar tráfico; si de verdad se fue, al vencer el plazo
          // se confirma la salida sin esperar el timeout de ICE.
          log('[FRONT-12] ⚠️ peer-left con WebRTC aún conectado → confirmo en 3s');
          // Lectura base ANTES de esperar: la comparación de dentro de 3s mide
          // el tráfico de esta ventana. Sin esto, el primer chequeo compararía
          // contra 0 y siempre parecería que sigue llegando audio.
          void isStillReceivingAudio();
          if (peerLeftTimerRef.current) clearTimeout(peerLeftTimerRef.current);
          peerLeftTimerRef.current = setTimeout(() => {
            peerLeftTimerRef.current = null;
            const stillFlowing = pcRef.current?.connectionState === 'connected';
            void (async () => {
              // Se consulta a WebRTC si SIGUE llegando audio del otro lado.
              // `bytesReceived` que no crece = el peer dejó de transmitir, o
              // sea que se fue de verdad aunque el estado siga en 'connected'.
              const receiving = await isStillReceivingAudio();
              if (stillFlowing && receiving) {
                log('[FRONT-12b] ✅ Sigue llegando audio → era un peer-left falso, lo ignoro');
                return;
              }
              log('[FRONT-12b] 👋 Confirmado: el peer se fue');
              markPeerGone();
            })();
          }, 3000);
          break;
        }

        case 'peer-arrived': {
          // Llegó (o volvió) alguien. Es solo informativo: NO se oferta acá,
          // eso le toca al que entra ('peer-joined'). Sirve para que la UI deje
          // de decir "esperando" o "se fue" sin tener que aguardar el audio.
          log('[FRONT-17] 🎉 Llegó un participante a la sala');
          // Si había un peer-left pendiente de confirmar, se cancela: el otro
          // está acá, así que aquel aviso quedó desmentido.
          if (peerLeftTimerRef.current) {
            clearTimeout(peerLeftTimerRef.current);
            peerLeftTimerRef.current = null;
          }
          if (msg.from && msg.from !== 'server') setPeerId(msg.from);
          setPeerMuted(false);
          setError(null);

          // Si el PeerConnection quedó inservible de la sesión anterior
          // (failed/closed tras la salida del otro), se descarta y se crea uno
          // nuevo: `setRemoteDescription` sobre un pc cerrado lanza, y la
          // oferta del que acaba de entrar no se podría contestar nunca.
          const stale =
            !pcRef.current ||
            pcRef.current.connectionState === 'failed' ||
            pcRef.current.connectionState === 'closed';
          if (stale) {
            log('[FRONT-17b] ♻️ El PeerConnection anterior no sirve → creo uno nuevo');
            pcRef.current?.close();
            hasRemoteDescRef.current = false;
            pendingIceRef.current = [];
            lastBytesRef.current = 0;
            createPeerConnection();
          }
          // Vuelve a 'connecting': el handshake recién arranca. Pasa a
          // 'connected' cuando WebRTC lo confirme.
          setStatus('connecting');
          break;
        }

        case 'peer-muted': {
          const isMuted = Boolean((msg.payload as { muted?: boolean })?.muted);
          log(`[FRONT-16] 🎙️ El peer ${isMuted ? 'SILENCIÓ' : 'reactivó'} su micrófono`);
          setPeerMuted(isMuted);
          break;
        }

        case 'role': {
          // El server nos dice si somos dueños. Llega al abrir el SSE (también
          // tras un F5, porque el front pierde el dato al recargar) y cuando
          // heredamos la room porque el dueño se fue.
          const owner = (msg.payload as { isOwner?: boolean } | undefined)
            ?.isOwner === true;
          log(`[FRONT-16] ${owner ? '👑 Soy DUEÑO de la room' : '🙋 Soy invitado'}`);
          setIsOwner(owner);
          break;
        }

        case 'kicked': {
          // ME EXPULSARON. A diferencia de peer-left, esto NO se valida contra
          // el estado de WebRTC: peer-left es una suposición sobre si el otro
          // sigue ahí (y el audio puede desmentirla), pero 'kicked' es una orden
          // explícita de alguien que SÍ está presente. Se obedece siempre.
          log('[FRONT-14] 🥾 Me EXPULSARON → cuelgo y vuelvo al lobby');
          setKicked(true);
          setError('You were removed from the room.');
          // Cortamos todo (mic, WebRTC, SSE) y soltamos la identidad de la room:
          // el server ya nos sacó del SET, así que si volvés entrás como nuevo.
          await hangupRef.current?.();
          setStatus('disconnected');
          break;
        }
      }
    },
    [
      flushPendingIce,
      post,
      roomId,
      isStillReceivingAudio,
      markPeerGone,
      createPeerConnection,
    ],
  );

  // Mantener el puntero al día en cada render (ver handleSignalRef arriba).
  useEffect(() => {
    handleSignalRef.current = (msg) => void handleSignal(msg);
  }, [handleSignal]);

  const join = useCallback(async () => {
    if (!roomId) {
      setError('Enter a room ID.');
      return;
    }
    // Sin sesión no hay identidad ni token: el server rechazaría el SSE con 401.
    // La UI ya protege la ruta, esto es la red por si se llama a join() antes de
    // que Auth0 termine de restaurar la sesión.
    if (!isAuthenticated || !user?.sub) {
      setStatus('error');
      setError('You must sign in to join a call.');
      return;
    }
    setError(null);
    // Nueva unión: se rearma la guarda de hangup() (podés unirte, colgar y
    // volver a unirte sin recargar la página).
    leftRef.current = false;

    /**
     * Identificador de ESTE intento de unión.
     *
     * join() es asíncrono (pide el micrófono antes de abrir el SSE). Al salir y
     * volver a entrar rápido, el hangup() del intento anterior corría MIENTRAS
     * este join esperaba el micrófono, y cerraba el SSE recién abierto: quedabas
     * fuera de la sala pero en la pantalla de llamada, y el otro no te veía.
     *
     * Con este contador, cada paso posterior a un `await` comprueba que sigue
     * siendo el intento vigente; si no, se abandona sin tocar nada.
     */
    const attempt = ++joinAttemptRef.current;
    const isStale = () => attempt !== joinAttemptRef.current;

    setStatus('connecting');
    log(`[FRONT-01] 🚀 join() | clientId=${clientIdRef.current} room=${roomId}`);

    // 1) Micrófono (requiere HTTPS o localhost).
    try {
      log('[FRONT-02] 🎤 Pidiendo micrófono (getUserMedia)...');
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      log('[FRONT-02] ✅ Micrófono concedido');
      // Si mientras pedíamos el micrófono se colgó o se relanzó join(), este
      // intento ya no vale: soltamos las pistas para no dejar el mic tomado.
      if (isStale()) {
        log('[FRONT-02b] ⏭️ join() obsoleto tras el micrófono → abandono');
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        return;
      }
    } catch {
      log('[FRONT-02] ❌ Micrófono DENEGADO');
      setStatus('error');
      setError('Microphone permission denied or unavailable.');
      return;
    }

    // 2) RTCPeerConnection con las pistas locales.
    createPeerConnection();

    // 3) SSE: recibimos la señalización por aquí.
    // El token va en el QUERY y no en un header porque EventSource no permite
    // mandar cabeceras. Es el patrón habitual para SSE autenticado; el costo es
    // que el token queda en logs de acceso y en el historial, y se mitiga con
    // tokens de vida corta. El clientId NO se manda: el server lo deriva del
    // `sub` del token.
    const sseToken = await getToken();
    if (isStale()) {
      log('[FRONT-03b] ⏭️ join() obsoleto tras pedir el token → no abro el SSE');
      return;
    }
    const url = `${API_URL}/signaling/stream?roomId=${encodeURIComponent(
      roomId,
    )}&token=${encodeURIComponent(sseToken)}`;
    log('[FRONT-03] 🔌 Abriendo SSE (EventSource):', url);
    const es = new EventSource(url);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as SignalMessage;
        // Vía el ref, NO capturando handleSignal directo: este callback se
        // asigna una única vez y quedaría pegado a la versión de ahora.
        handleSignalRef.current?.(msg);
      } catch {
        /* mensaje no JSON: ignorar */
      }
    };

    // Reconexión SSE básica: EventSource reintenta solo; solo reflejamos estado.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        log('[FRONT-SSE-ERR] ⚠️ SSE CERRADO');
        setStatus('disconnected');
      } else {
        log('[FRONT-SSE-ERR] ⚠️ SSE error transitorio, EventSource reintenta solo...');
      }
    };
    // handleSignal NO va en las deps: se consume por ref (handleSignalRef), y
    // si estuviera acá join() se recrearía en cada cambio de peerId/isOwner.
  }, [createPeerConnection, roomId, isAuthenticated, getToken, user?.sub]);

  const hangup = useCallback(async () => {
    // IDEMPOTENTE: hangup() se dispara dos veces al volver al lobby (el botón
    // "Colgar / Volver" lo llama explícito, y además corre el cleanup del effect
    // al desmontar Room). Sin esta guarda, el segundo POST /leave sería un
    // duplicado inútil.
    //
    // La bandera es un ref propio y NO "vaciar clientIdRef": ahora la identidad
    // es el `sub` de Auth0, que es de la sesión y no de la llamada, así que
    // borrarlo dejaría al usuario sin poder volver a unirse hasta recargar.
    if (leftRef.current) {
      log('[FRONT-13] 📴 hangup() ignorado: ya se colgó');
      return;
    }
    // Se marca ANTES del await para que una segunda llamada concurrente salga
    // por la guarda de arriba en vez de duplicar el leave.
    leftRef.current = true;
    // Invalida cualquier join() en vuelo: si uno estaba esperando el micrófono
    // o el token, al volver verá que su intento ya no es el vigente y se
    // detendrá en vez de abrir un SSE que nadie va a cerrar.
    joinAttemptRef.current++;

    log('[FRONT-13] 📴 hangup() → POST leave (sin esperar), cierro SSE, PeerConnection y mic');

    // El POST /leave se dispara SIN await: colgar es informarle al server, no
    // pedirle permiso. Esperarlo agregaba ~400ms de demora antes de volver al
    // lobby, porque cada comando a Upstash cuesta ~40ms y la baja hace varios.
    //
    // Si la request se pierde, no se rompe nada: el server también da de baja
    // al cerrarse el SSE (que sucede acá mismo, dos líneas abajo), y en última
    // instancia está el TTL de la sala en Redis.
    void post('leave', { roomId }).catch(() => undefined);

    esRef.current?.close();
    esRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    hasRemoteDescRef.current = false;
    pendingIceRef.current = [];
    setMuted(false);
    setPeerConnected(false);
    setPeerId(null);
    setPeerMuted(false);
    setIsOwner(false);
    setStatus('idle');
    if (peerLeftTimerRef.current) {
      clearTimeout(peerLeftTimerRef.current);
      peerLeftTimerRef.current = null;
    }
    // Ya no hay nada que borrar de sessionStorage: la identidad es el `sub` de
    // Auth0 y vive mientras dure la sesión. El server ya nos sacó del SET de la
    // room con el /leave, que es lo que hace falta para que una nueva unión
    // cuente como entrada nueva y no como reconexión.
  }, [post, roomId]);

  // Exponer hangup al handler de señales (ver hangupRef arriba). Se asigna en
  // un effect y no en el cuerpo del render porque escribir un ref durante el
  // render es un side-effect: React puede descartar o repetir ese render.
  useEffect(() => {
    hangupRef.current = hangup;
  }, [hangup]);

  /**
   * Expulsar al peer. SOLO el dueño (creador) de la room puede hacerlo; esta
   * guarda es por prolijidad, la autorización de verdad la impone el server.
   *
   * Nosotros NO nos vamos: seguimos en la room esperando a que entre otro. Solo
   * cerramos el RTCPeerConnection, que quedó apuntando a alguien que ya no está;
   * cuando entre un nuevo peer, el server nos mandará 'peer-joined' y se crea
   * una conexión nueva desde cero.
   */
  const kick = useCallback(async () => {
    if (!isOwner) {
      log('[FRONT-15] 🥾 kick() ignorado: no soy el dueño de la room');
      return;
    }
    if (!peerId) {
      log('[FRONT-15] 🥾 kick() ignorado: todavía no sé el clientId del peer');
      return;
    }
    log(`[FRONT-15] 🥾 kick() → expulso a ${peerId}`);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/signaling/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          roomId,
          targetId: peerId,
        }),
      });
      // El server responde { ok: false } si nos rechaza (no somos dueños).
      // Sin mirarlo, el botón "no hacía nada" y no había forma de saber por qué.
      const body = (await res.json()) as { ok?: boolean };
      if (!body.ok) {
        log('[FRONT-15] 🚫 El server RECHAZÓ el kick (no soy el dueño)');
        setError('You cannot remove anyone: you are not the room owner.');
        return;
      }
    } catch {
      log('[FRONT-15] ❌ Falló el POST /kick');
      setError('Could not remove the participant.');
      return;
    }
    // Cerrar la conexión WebRTC vieja: el peer ya no está del otro lado.
    pcRef.current?.close();
    pcRef.current = null;
    hasRemoteDescRef.current = false;
    pendingIceRef.current = [];
    setPeerConnected(false);
    setPeerId(null);
    setPeerMuted(false);
    // Recrear el PeerConnection para quedar listos para el próximo participante.
    createPeerConnection();
    setStatus('connecting');
  }, [createPeerConnection, isOwner, peerId, roomId, getToken]);

  /**
   * Mute/unmute: alterna `enabled` en las pistas de audio locales. Con
   * `enabled = false` el navegador sigue enviando la pista pero en silencio,
   * sin renegociar WebRTC (no toca el SDP).
   */
  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    setMuted((prev) => {
      const next = !prev;
      tracks.forEach((t) => (t.enabled = !next));
      // Avisar al peer. `enabled = false` no cambia el SDP ni corta la pista,
      // así que el otro lado no se enteraría por WebRTC: seguiría viendo el
      // micrófono activo mientras escucha silencio.
      void post('mute', { roomId, muted: next });
      return next;
    });
  }, [post, roomId]);

  // Avisar al server SOLO cuando la página se descarga de verdad.
  //
  // Antes usábamos 'beforeunload', que dispara de más (cambiar de pestaña en el
  // móvil, bloquear pantalla, etc.) y mandaba LEAVE falsos → el otro veía
  // "abandonó el room" mientras seguían hablando. Usamos 'pagehide' con
  // `persisted === false`, que indica que la página se va realmente (no que
  // pasa al bgcache). Aun así, si se colara un leave de más, el handler de
  // peer-left ya lo ignora mientras WebRTC siga conectado.
  //
  // AUTENTICACIÓN EN EL BEACON: `sendBeacon` no permite headers, así que el
  // token no puede ir en `Authorization` y viaja en el query (igual que en el
  // SSE). Y como en `pagehide` ya no hay tiempo de pedirle un token a Auth0
  // (es asíncrono y la página se está muriendo), lo dejamos cacheado en un ref
  // que se refresca mientras la llamada está viva.
  //
  // Si el beacon igual falla, no se pierde nada crítico: el server tiene la
  // baja por cierre del SSE y, en última instancia, el TTL de la room en Redis.
  const beaconTokenRef = useRef<string>('');
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    // Se refresca junto con la sesión; con que sea razonablemente reciente
    // alcanza, porque solo se usa en el último instante de la página.
    void getToken().then((t) => {
      if (!cancelled) beaconTokenRef.current = t;
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getToken, status]);

  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return; // va al back-forward cache, NO es un cierre real
      if (!beaconTokenRef.current) return;
      const blob = new Blob([JSON.stringify({ roomId })], {
        type: 'application/json',
      });
      navigator.sendBeacon(
        `${API_URL}/signaling/leave?token=${encodeURIComponent(
          beaconTokenRef.current,
        )}`,
        blob,
      );
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [roomId]);

  return {
    // El `sub` de Auth0: es nuestro id dentro de la room. Se lee del user (no
    // del ref) porque durante el render los refs no se pueden tocar.
    clientId: user?.sub ?? '',
    status,
    error,
    muted,
    peerConnected,
    peerId,
    peerMuted,
    kicked,
    isOwner,
    remoteAudioRef,
    join,
    hangup,
    kick,
    toggleMute,
  };
}
