import Box from '@mui/material/Box';
import { keyframes } from '@mui/material/styles';

/**
 * Ondas de audio animadas: 5 barras que escalan en vertical, desfasadas entre
 * sí. Es el indicador de "hablando" de la maqueta (`resources/room/`).
 *
 * Puramente decorativo — NO refleja el volumen real del micrófono, solo indica
 * que hay una pista de audio activa. Por eso lleva aria-hidden: el estado real
 * se anuncia con el texto que acompaña a la píldora.
 */
const wave = keyframes`
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
`;

/** Altura relativa de cada barra y su desfase, para que no latan al unísono. */
const BARS = [
  { height: '40%', delay: '0s' },
  { height: '80%', delay: '0.2s' },
  { height: '100%', delay: '0.4s' },
  { height: '70%', delay: '0.6s' },
  { height: '50%', delay: '0.8s' },
];

function AudioWave({ color }: { color: string }) {
  return (
    <Box
      aria-hidden
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: 24,
      }}
    >
      {BARS.map((bar, i) => (
        <Box
          key={i}
          sx={{
            width: 4,
            height: bar.height,
            borderRadius: 2,
            bgcolor: color,
            transformOrigin: 'center',
            animation: `${wave} 1s ease-in-out infinite`,
            animationDelay: bar.delay,
          }}
        />
      ))}
    </Box>
  );
}

export default AudioWave;
