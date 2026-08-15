import { useRef } from 'react';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import HeadsetMicIcon from '@mui/icons-material/HeadsetMic';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import Box from '@mui/material/Box';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { brand, support } from './theme';

/**
 * Bloque decorativo del hero, con círculos de color animados con GSAP.
 *
 * Es puramente ornamental (`aria-hidden`), no muestra datos. Se anima el DOM
 * en vez de usar WebGL para conservar los íconos de MUI, que son SVG del DOM.
 *
 * Tiene dos formas según el ancho:
 *  - MOBILE: franja de ancho completo, con los círculos repartidos a lo largo.
 *  - DESKTOP: bloque compacto de 280x210 a la derecha del texto del hero.
 * En ambos casos el ALTO es fijo, así el bloque no se agranda con la pantalla.
 */
function HeroDecoration() {
  const root = useRef<HTMLDivElement>(null);

  // useGSAP limpia solas las animaciones al desmontar (equivale a un
  // gsap.context().revert()), evitando tweens huérfanos sobre nodos muertos.
  useGSAP(
    () => {
      // Respetamos a quien pidió menos movimiento a nivel sistema operativo:
      // mostramos la banda estática y no arrancamos ningún tween.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        gsap.set('[data-float]', { opacity: 1, scale: 1 });
        return;
      }

      // Entrada escalonada de izquierda a derecha. Anima SOLO opacity/scale:
      // x/y quedan para los tweens de órbita, que corren en paralelo sobre las
      // mismas propiedades y se pisarían entre sí.
      gsap.from('[data-float]', {
        opacity: 0,
        scale: 0.6,
        duration: 0.7,
        ease: 'back.out(1.7)',
        stagger: 0.1,
      });

      // Órbitas circulares, continuas y sin saltos.
      //
      // Se anima un ÁNGULO de 0 a 360 y en cada frame se derivan x/y con
      // seno y coseno. Esto da una trayectoria perfectamente circular a
      // velocidad constante (`ease: 'none'`).
      //
      // Por qué así y no con dos tweens `yoyo` desfasados: un yoyo con
      // `sine.inOut` FRENA en cada extremo del recorrido, y el `delay` que
      // los desfasa deja al círculo congelado hasta que arranca. Las dos
      // cosas se ven como tirones. Acá el ángulo nunca se detiene: al llegar
      // a 360 el ciclo reinicia en 0, que es exactamente el mismo punto.
      //
      // Cada círculo tiene su propio radio y duración para que las órbitas no
      // caigan en fase y el conjunto no gire como un bloque rígido.
      // Los radios se miden contra el alto de la banda (128px en mobile) menos
      // el diámetro del círculo: pasarse hace que se salga del recuadro y el
      // `overflow: hidden` lo recorte. El principal (c) es el más grande, así
      // que es el que menos margen tiene para moverse.
      const orbits: { sel: string; radius: number; duration: number }[] = [
        { sel: '[data-float="a"]', radius: 20, duration: 7 },
        { sel: '[data-float="b"]', radius: 22, duration: 9 },
        { sel: '[data-float="c"]', radius: 12, duration: 11 },
        { sel: '[data-float="d"]', radius: 21, duration: 8 },
        { sel: '[data-float="e"]', radius: 19, duration: 10 },
      ];
      orbits.forEach(({ sel, radius, duration }, i) => {
        const el = gsap.utils.toArray<HTMLElement>(sel)[0];
        if (!el) return;

        const state = { angle: 0 };
        gsap.to(state, {
          angle: Math.PI * 2,
          duration,
          ease: 'none', // velocidad angular constante: sin frenadas
          repeat: -1,
          onUpdate: () => {
            gsap.set(el, {
              x: Math.cos(state.angle) * radius,
              y: Math.sin(state.angle) * radius,
            });
          },
        });

        // Cada órbita empieza en un punto distinto de su circunferencia.
        // `progress` adelanta el tween SIN congelarlo: a diferencia de un
        // `delay`, el movimiento ya arranca en marcha.
        gsap.getTweensOf(state)[0]?.progress(i / orbits.length);
      });

      // Onda de voz saliendo del círculo principal.
      gsap.to('[data-ring]', {
        scale: 2.2,
        opacity: 0,
        duration: 2.2,
        ease: 'power2.out',
        repeat: -1,
      });

      // El ícono de ondas acompaña con un pulso propio, como un ecualizador.
      gsap.to('[data-eq-icon]', {
        scaleY: 1.35,
        duration: 0.6,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
        transformOrigin: 'center',
      });

      // Puntitos de fondo: parpadeo lento y desfasado.
      gsap.to('[data-dot]', {
        opacity: 0.15,
        duration: 1.8,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
        stagger: { each: 0.2, from: 'random' },
      });
    },
    { scope: root },
  );

  return (
    <Box
      ref={root}
      aria-hidden
      sx={{
        // Mobile: ocupa todo el ancho disponible. Desktop: vuelve al bloque
        // compacto de medida fija, a la derecha del texto.
        width: { xs: '100%', md: 280 },
        // Alto fijo en ambos casos: no crece con el ancho de la pantalla.
        height: { xs: 128, md: 210 },
        flexShrink: 0,
        borderRadius: '20px',
        bgcolor: support.surfaceRaised,
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        px: { xs: 4, md: 5 },
      }}
    >
      {/* Puntitos de fondo: llenan el ancho de la franja en mobile. En el
          bloque angosto de desktop no hacen falta. */}
      {[18, 34, 50, 66, 82].map((left, i) => (
        <Box
          key={left}
          data-dot
          sx={{
            display: { xs: 'block', md: 'none' },
            position: 'absolute',
            left: `${left}%`,
            top: i % 2 === 0 ? '22%' : '72%',
            width: 6,
            height: 6,
            borderRadius: '50%',
            bgcolor: brand.coral,
            opacity: 0.4,
          }}
        />
      ))}

      {/* Círculos de relleno (a, e): existen para que la franja ANCHA del
          mobile no quede vacía a los costados. En desktop el bloque es angosto
          (280px) y con cinco círculos quedaría apretado, así que se ocultan.
          En pantallas muy chicas también, para no amontonar. */}
      <Box
        data-float="a"
        sx={{
          display: { xs: 'none', sm: 'grid', md: 'none' },
          placeItems: 'center',
          width: 44,
          height: 44,
          borderRadius: '50%',
          bgcolor: '#C5E5F3',
          color: '#45636E',
          zIndex: 1,
        }}
      >
        <HeadsetMicIcon sx={{ fontSize: 20 }} />
      </Box>

      <Box
        data-float="b"
        sx={{
          display: 'grid',
          placeItems: 'center',
          width: 52,
          height: 52,
          borderRadius: '50%',
          bgcolor: brand.mint,
          color: brand.mintText,
          zIndex: 1,
        }}
      >
        <GraphicEqIcon data-eq-icon sx={{ fontSize: 24 }} />
      </Box>

      {/* Círculo principal, al centro de la banda. La órbita se aplica a ESTE
          wrapper (no al círculo de adentro) para que el anillo de la onda,
          que es hermano del círculo, viaje con él en vez de quedarse fijo. */}
      <Box
        data-float="c"
        sx={{ position: 'relative', display: 'grid', zIndex: 1 }}
      >
        <Box
          data-ring
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '2px solid',
            borderColor: 'primary.main',
            opacity: 0.5,
          }}
        />
        <Box
          sx={{
            display: 'grid',
            placeItems: 'center',
            width: { xs: 64, sm: 76 },
            height: { xs: 64, sm: 76 },
            borderRadius: '50%',
            bgcolor: 'primary.main',
            color: brand.white,
          }}
        >
          <RecordVoiceOverIcon sx={{ fontSize: { xs: 30, sm: 36, md: 44 } }} />
        </Box>
      </Box>

      <Box
        data-float="d"
        sx={{
          display: 'grid',
          placeItems: 'center',
          width: 48,
          height: 48,
          borderRadius: '50%',
          bgcolor: '#C5E5F3',
          color: '#45636E',
          zIndex: 1,
        }}
      >
        <HeadsetMicIcon sx={{ fontSize: 22 }} />
      </Box>

      <Box
        data-float="e"
        sx={{
          display: { xs: 'none', sm: 'grid', md: 'none' },
          placeItems: 'center',
          width: 40,
          height: 40,
          borderRadius: '50%',
          bgcolor: brand.mint,
          color: brand.mintText,
          zIndex: 1,
        }}
      >
        <GraphicEqIcon sx={{ fontSize: 18 }} />
      </Box>
    </Box>
  );
}

export default HeroDecoration;
