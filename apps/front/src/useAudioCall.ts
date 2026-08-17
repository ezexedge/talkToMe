import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { playPeerJoined, playPeerLeft } from './callSounds';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const STUN = 'stun:stun.l.google.com:19302';

const log = (...args: unknown[]) =>
  console.log('%c[CALL]', 'color:#7c3aed;font-weight:bold', ...args);

export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'room-full'
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
  const [peerConnected, setPeerConnected] = useState(false);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [kicked, setKicked] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [peerMuted, setPeerMuted] = useState(false);

  const { user, getAccessTokenSilently, isAuthenticated } = useAuth0();

  const clientIdRef = useRef<string>('');
  useEffect(() => {
    if (user?.sub) clientIdRef.current = user.sub;
  }, [user?.sub]);

  const getToken = useCallback(async (): Promise<string> => {
    return getAccessTokenSilently();
  }, [getAccessTokenSilently]);

  const joinAttemptRef = useRef(0);

  const leftRef = useRef(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const hasRemoteDescRef = useRef(false);

  const peerLeftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastBytesRef = useRef(0);

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
      return false;
    }
  }, []);

  const markPeerGone = useCallback(() => {
    // Único punto de salida CONFIRMADA del peer (los peer-left falsos ya se
    // filtraron antes de llegar acá), así que el sonido va justo aquí y no se
    // repite.
    playPeerLeft();
    setPeerConnected(false);
    setPeerId(null);
    setPeerMuted(false);
    setStatus('disconnected');
    setError('The other participant left the room.');
  }, []);

  const hangupRef = useRef<(() => Promise<void>) | null>(null);

  const handleSignalRef = useRef<((msg: SignalMessage) => void) | null>(null);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      log(`[FRONT-POST] ⬆️ POST /signaling/${path}`, body);
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

    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current as MediaStream);
      log('[FRONT-05] 🎙️ Pista de audio local agregada al PeerConnection');
    });

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

    pc.ontrack = (ev) => {
      log('[FRONT-TRACK] 🔊 ¡Llegó AUDIO REMOTO! Lo enchufo al <audio>. Ya hay peer.');
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = ev.streams[0];
      }
      // Sonido SOLO en la transición ausente→presente. `ontrack` puede
      // dispararse de nuevo en una renegociación con el peer ya conectado; sin
      // este guard, el beep de "entró" sonaría cada vez.
      setPeerConnected((prev) => {
        if (!prev) playPeerJoined();
        return true;
      });
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
        /* ignored */
      }
    }
    pendingIceRef.current = [];
  }, []);

  const handleSignal = useCallback(
    async (msg: SignalMessage) => {
      const pc = pcRef.current;
      log(`[FRONT-SSE-IN] ⬇️ Bajó por SSE: type=${msg.type} from=${msg.from} (pc listo? ${!!pc})`);

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
          const current = pcRef.current;
          const needsFresh =
            !current ||
            current.connectionState === 'failed' ||
            current.connectionState === 'closed' ||
            current.signalingState === 'closed' ||
            hasRemoteDescRef.current; 

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
          const target = pcRef.current;
          if (!target || !hasRemoteDescRef.current) {
            log('[FRONT-ICE-IN] 🧊 ICE remoto llegó ANTES de tener descripción remota → lo ENCOLO');
            pendingIceRef.current.push(cand);
          } else {
            log('[FRONT-ICE-IN] 🧊 ICE remoto → addIceCandidate (aplicado ya)');
            try {
              await target.addIceCandidate(cand);
            } catch {
        /* ignored */
      }
          }
          break;
        }

        case 'peer-left': {
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

          log('[FRONT-12] ⚠️ peer-left con WebRTC aún conectado → confirmo en 3s');
          void isStillReceivingAudio();
          if (peerLeftTimerRef.current) clearTimeout(peerLeftTimerRef.current);
          peerLeftTimerRef.current = setTimeout(() => {
            peerLeftTimerRef.current = null;
            const stillFlowing = pcRef.current?.connectionState === 'connected';
            void (async () => {
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
          log('[FRONT-17] 🎉 Llegó un participante a la sala');
          if (peerLeftTimerRef.current) {
            clearTimeout(peerLeftTimerRef.current);
            peerLeftTimerRef.current = null;
          }
          if (msg.from && msg.from !== 'server') setPeerId(msg.from);
          setPeerMuted(false);
          setError(null);

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
          const owner = (msg.payload as { isOwner?: boolean } | undefined)
            ?.isOwner === true;
          log(`[FRONT-16] ${owner ? '👑 Soy DUEÑO de la room' : '🙋 Soy invitado'}`);
          setIsOwner(owner);
          break;
        }

        case 'kicked': {
          log('[FRONT-14] 🥾 Me EXPULSARON → cuelgo y vuelvo al lobby');
          setKicked(true);
          setError('You were removed from the room.');
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

  useEffect(() => {
    handleSignalRef.current = (msg) => void handleSignal(msg);
  }, [handleSignal]);

  const join = useCallback(async () => {
    if (!roomId) {
      setError('Enter a room ID.');
      return;
    }
    if (!isAuthenticated || !user?.sub) {
      setStatus('error');
      setError('You must sign in to join a call.');
      return;
    }
    setError(null);
    leftRef.current = false;

    // join() awaits the mic; a stale hangup() would otherwise close the new SSE.
    const attempt = ++joinAttemptRef.current;
    const isStale = () => attempt !== joinAttemptRef.current;

    setStatus('connecting');
    log(`[FRONT-01] 🚀 join() | clientId=${clientIdRef.current} room=${roomId}`);

    try {
      log('[FRONT-02] 🎤 Pidiendo micrófono (getUserMedia)...');
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      log('[FRONT-02] ✅ Micrófono concedido');
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

    createPeerConnection();

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
        handleSignalRef.current?.(msg);
      } catch {
        /* ignored */
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        log('[FRONT-SSE-ERR] ⚠️ SSE CERRADO');
        setStatus('disconnected');
      } else {
        log('[FRONT-SSE-ERR] ⚠️ SSE error transitorio, EventSource reintenta solo...');
      }
    };
  }, [createPeerConnection, roomId, isAuthenticated, getToken, user?.sub]);

  const hangup = useCallback(async () => {
    if (leftRef.current) {
      log('[FRONT-13] 📴 hangup() ignorado: ya se colgó');
      return;
    }
    leftRef.current = true;
    joinAttemptRef.current++;

    log('[FRONT-13] 📴 hangup() → POST leave (sin esperar), cierro SSE, PeerConnection y mic');

    // Not awaited: leaving is a notification, and waiting added ~400ms.
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
  }, [post, roomId]);

  useEffect(() => {
    hangupRef.current = hangup;
  }, [hangup]);

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
    pcRef.current?.close();
    pcRef.current = null;
    hasRemoteDescRef.current = false;
    pendingIceRef.current = [];
    setPeerConnected(false);
    setPeerId(null);
    setPeerMuted(false);
    createPeerConnection();
    setStatus('connecting');
  }, [createPeerConnection, isOwner, peerId, roomId, getToken]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    setMuted((prev) => {
      const next = !prev;
      tracks.forEach((t) => (t.enabled = !next));
      void post('mute', { roomId, muted: next });
      return next;
    });
  }, [post, roomId]);

  const beaconTokenRef = useRef<string>('');
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void getToken().then((t) => {
      if (!cancelled) beaconTokenRef.current = t;
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getToken, status]);

  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return; 
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
