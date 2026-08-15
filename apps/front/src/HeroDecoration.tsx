import { useRef } from 'react';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import HeadsetMicIcon from '@mui/icons-material/HeadsetMic';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import Box from '@mui/material/Box';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { brand, support } from './theme';

function HeroDecoration() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        gsap.set('[data-float]', { opacity: 1, scale: 1 });
        return;
      }

      gsap.from('[data-float]', {
        opacity: 0,
        scale: 0.6,
        duration: 0.7,
        ease: 'back.out(1.7)',
        stagger: 0.1,
      });

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
          ease: 'none', 
          repeat: -1,
          onUpdate: () => {
            gsap.set(el, {
              x: Math.cos(state.angle) * radius,
              y: Math.sin(state.angle) * radius,
            });
          },
        });

        gsap.getTweensOf(state)[0]?.progress(i / orbits.length);
      });

      gsap.to('[data-ring]', {
        scale: 2.2,
        opacity: 0,
        duration: 2.2,
        ease: 'power2.out',
        repeat: -1,
      });

      gsap.to('[data-eq-icon]', {
        scaleY: 1.35,
        duration: 0.6,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
        transformOrigin: 'center',
      });

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
        width: { xs: '100%', md: 280 },
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
