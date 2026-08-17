// Sonidos de entrada/salida de la room, generados con Web Audio API.
//
// Se generan en vez de cargar archivos .mp3 por tres razones: no suman peso al
// bundle, no hay request que pueda fallar, y suenan idénticos en todos lados.
//
// Sobre "sonar en otra app": un AudioContext sigue produciendo sonido con la
// pestaña en segundo plano. El límite real es del navegador —si la pestaña
// pasa a background profundo puede suspender el audio—, no de este código.

let ctx: AudioContext | null = null;

/**
 * El AudioContext se crea perezosamente y NO en la carga del módulo: los
 * navegadores lo arrancan en estado 'suspended' hasta el primer gesto del
 * usuario (política de autoplay). Se crea/resume recién cuando hay que sonar,
 * que para este caso siempre ocurre después de que el usuario entró a la room
 * (un gesto), así que ya está desbloqueado.
 */
function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Un beep corto y suave. La envolvente (ataque rápido + caída exponencial)
 * evita el 'click' que produciría cortar la onda de golpe.
 */
function beep(freq: number, duration: number, startAt = 0): void {
  const audio = getCtx();
  if (!audio) return;

  const t0 = audio.currentTime + startAt;
  const osc = audio.createOscillator();
  const gain = audio.createGain();

  osc.type = 'sine';
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.12, t0 + 0.02); // ataque suave, volumen bajo
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration); // caída

  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Dos notas de una tríada mayor (amigable, "resuelto"). Ascendente = llega,
// descendente = se va. Ondas sine puras: lo más suave posible, nada estridente.

/** Alguien ENTRÓ: dos notas que suben, cálidas y breves. */
export function playPeerJoined(): void {
  beep(523.25, 0.14); // Do5
  beep(783.99, 0.24, 0.12); // Sol5, encadenado
}

/** Alguien SE FUE: dos notas que bajan, gentiles. */
export function playPeerLeft(): void {
  beep(783.99, 0.14); // Sol5
  beep(523.25, 0.26, 0.12); // Do5, encadenado
}
