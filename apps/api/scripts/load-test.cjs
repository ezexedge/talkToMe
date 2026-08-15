/**
 * Prueba de carga: N salas 1-a-1 simultáneas con señalización real y WebRTC real.
 *
 * Uso:
 *   node scripts/load-test.cjs [salas] [segundos]
 *   node scripts/load-test.cjs 25 30
 *
 * QUÉ MIDE Y QUÉ NO:
 *  - SÍ mide tu SERVIDOR: conexiones SSE abiertas, canales de Redis Pub/Sub,
 *    membresía de salas, y la latencia del handshake de señalización. Ese es el
 *    límite real del backend.
 *  - SÍ verifica que WebRTC llegue a `connected` de punta a punta, o sea que la
 *    señalización enrutó bien offer/answer/ICE con muchas salas en paralelo.
 *  - NO mide la capacidad de audio en producción: el media de WebRTC va DIRECTO
 *    entre peers y no toca el server. Acá los dos peers viven en este mismo
 *    proceso Node, así que el techo de conexiones WebRTC que veas es de ESTA
 *    máquina, no de tu backend.
 *
 * Requiere en el .env del API:
 *   LOAD_TEST_SECRET=algo   (y NODE_ENV != production)
 */
const { RTCPeerConnection, nonstandard } = require('@roamhq/wrtc');
const { EventSource } = require('eventsource');
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.LOAD_TEST_API ?? 'http://localhost:3000';
const SECRET = process.env.LOAD_TEST_SECRET;
const ROOMS = Number(process.argv[2] ?? 10);
const HOLD_SECONDS = Number(process.argv[3] ?? 20);
const STUN = 'stun:stun.l.google.com:19302';

if (!SECRET) {
  console.error('Falta LOAD_TEST_SECRET en apps/api/.env');
  process.exit(1);
}

/** Métricas globales. */
const stats = {
  sseOpened: 0,
  sseErrors: 0,
  offers: 0,
  answers: 0,
  ice: 0,
  connected: 0,
  failed: 0,
  postErrors: 0,
  handshakeMs: [],
};

const auth = (sub) => ({
  'Content-Type': 'application/json',
  'x-load-test': SECRET,
  'x-load-test-sub': sub,
});

async function post(path, sub, body) {
  try {
    const res = await fetch(`${API}/signaling/${path}`, {
      method: 'POST',
      headers: auth(sub),
      body: JSON.stringify(body),
    });
    if (!res.ok) stats.postErrors++;
  } catch {
    stats.postErrors++;
  }
}

/**
 * Un participante simulado: abre su SSE, crea un RTCPeerConnection con una
 * pista de audio sintética, y responde a la señalización igual que el front.
 */
function createParticipant(roomId, sub) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });

  // Pista de audio generada por software (no hay micrófono en Node). Es
  // necesaria para que el SDP negocie media de verdad y no una sesión vacía.
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();
  pc.addTrack(track);
  // Alimentar la pista con silencio a 48kHz; sin datos, el track queda inerte.
  const samples = new Int16Array(480);
  const feeder = setInterval(() => {
    try {
      source.onData({
        samples,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 480,
      });
    } catch {
      /* la pista se cerró */
    }
  }, 10);

  const pendingIce = [];
  let hasRemote = false;
  const startedAt = Date.now();

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      stats.ice++;
      void post('ice-candidate', sub, {
        roomId,
        candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
      });
    }
  };

  // El evento dispara varias veces por peer (connected → disconnected →
  // connected, y en cada renegociación), así que se cuenta solo la PRIMERA vez
  // que este peer llega a conectado. Sin esto el total supera al nº de peers.
  let countedConnected = false;
  let countedFailed = false;

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && !countedConnected) {
      countedConnected = true;
      stats.connected++;
      stats.handshakeMs.push(Date.now() - startedAt);
    } else if (pc.connectionState === 'failed' && !countedFailed) {
      countedFailed = true;
      stats.failed++;
    }
  };

  const url =
    `${API}/signaling/stream?roomId=${encodeURIComponent(roomId)}` +
    `&loadTest=${encodeURIComponent(SECRET)}&loadTestSub=${encodeURIComponent(sub)}`;
  const es = new EventSource(url);

  es.onopen = () => stats.sseOpened++;
  es.onerror = () => stats.sseErrors++;

  es.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case 'peer-joined': {
          // Soy initiator: creo la oferta.
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          stats.offers++;
          await post('offer', sub, { roomId, sdp: offer });
          break;
        }
        case 'offer': {
          await pc.setRemoteDescription(msg.payload);
          hasRemote = true;
          for (const c of pendingIce.splice(0)) {
            await pc.addIceCandidate(c).catch(() => {});
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          stats.answers++;
          await post('answer', sub, { roomId, sdp: answer });
          break;
        }
        case 'answer': {
          await pc.setRemoteDescription(msg.payload);
          hasRemote = true;
          for (const c of pendingIce.splice(0)) {
            await pc.addIceCandidate(c).catch(() => {});
          }
          break;
        }
        case 'ice-candidate': {
          // Mismo encolado que el front: addIceCandidate falla sin descripción
          // remota.
          if (!hasRemote) pendingIce.push(msg.payload);
          else await pc.addIceCandidate(msg.payload).catch(() => {});
          break;
        }
      }
    } catch {
      /* un fallo puntual no debe tumbar la corrida */
    }
  };

  return {
    close: async () => {
      clearInterval(feeder);
      es.close();
      try {
        track.stop();
      } catch {
        /* ya cerrada */
      }
      pc.close();
      await post('leave', sub, { roomId });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `\n▶ Prueba de carga: ${ROOMS} salas (${ROOMS * 2} usuarios), sostenida ${HOLD_SECONDS}s`,
  );
  console.log(`  API: ${API}\n`);

  const t0 = Date.now();
  const participants = [];

  for (let i = 0; i < ROOMS; i++) {
    const roomId = `loadtest-${t0}-${i}`;
    // El PRIMERO en entrar no es initiator; el segundo sí. Se respeta el orden
    // real esperando un poco entre ambos, como haría un usuario.
    participants.push(createParticipant(roomId, `loadtest|${i}-a`));
    await sleep(30);
    participants.push(createParticipant(roomId, `loadtest|${i}-b`));
    // Escalonar la creación evita un pico artificial que mediría el arranque
    // en vez del régimen permanente.
    await sleep(40);
  }

  const rampMs = Date.now() - t0;
  console.log(`  Todas las salas creadas en ${(rampMs / 1000).toFixed(1)}s`);
  console.log(`  Sosteniendo ${HOLD_SECONDS}s...\n`);

  // Muestreo periódico mientras se sostiene la carga.
  const ticker = setInterval(() => {
    process.stdout.write(
      `\r  conectados: ${stats.connected}/${ROOMS * 2}  ` +
        `sse: ${stats.sseOpened}  ice: ${stats.ice}  ` +
        `fallos: ${stats.failed}  errPost: ${stats.postErrors}   `,
    );
  }, 1000);

  await sleep(HOLD_SECONDS * 1000);
  clearInterval(ticker);

  // Estado del server en pleno pico, antes de desconectar.
  let roomsSeen = 0;
  try {
    const res = await fetch(`${API}/signaling/rooms`);
    roomsSeen = (await res.json()).length;
  } catch {
    /* ignorar */
  }

  console.log('\n\n─── RESULTADOS ───');
  console.log(`Salas objetivo        : ${ROOMS}`);
  console.log(`Salas vistas por API  : ${roomsSeen}`);
  console.log(`Usuarios simulados    : ${ROOMS * 2}`);
  console.log(`SSE abiertos          : ${stats.sseOpened}`);
  console.log(`SSE con error         : ${stats.sseErrors}`);
  console.log(`Offers / Answers      : ${stats.offers} / ${stats.answers}`);
  console.log(`ICE enviados          : ${stats.ice}`);
  console.log(`WebRTC conectados     : ${stats.connected} / ${ROOMS * 2}`);
  console.log(`WebRTC fallidos       : ${stats.failed}`);
  console.log(`POST con error        : ${stats.postErrors}`);

  if (stats.handshakeMs.length) {
    const s = [...stats.handshakeMs].sort((a, b) => a - b);
    const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    console.log(
      `Handshake (ms)        : p50=${p(0.5)}  p95=${p(0.95)}  max=${s[s.length - 1]}`,
    );
  }

  console.log('\nCerrando…');
  await Promise.all(participants.map((p) => p.close()));
  await sleep(1500);

  try {
    const res = await fetch(`${API}/signaling/rooms`);
    const left = (await res.json()).filter((r) =>
      r.roomId.startsWith('loadtest-'),
    );
    console.log(
      `Salas de prueba que quedan: ${left.length} (deberían expirar solas)`,
    );
  } catch {
    /* ignorar */
  }

  process.exit(0);
}

void main();
