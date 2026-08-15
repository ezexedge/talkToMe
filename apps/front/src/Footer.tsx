import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { support } from './theme';

/**
 * Footer con el crédito de autoría.
 *
 * Componente propio y no markup suelto en Home, para que cualquier pantalla que
 * lo necesite lo importe sin duplicar el enlace ni el estilo.
 */
function Footer() {
  return (
    <Box
      component="footer"
      sx={{
        borderTop: '1px solid',
        borderColor: 'divider',
        py: 6,
        px: { xs: 5, md: 12 },
        mt: 'auto',
      }}
    >
      <Container disableGutters maxWidth="lg">
        <Typography variant="body2" color="text.secondary" align="center">
          Created by{' '}
          <Link
            href="https://www.200hub.tech/"
            // Se abre en una pestaña nueva para no cortar una llamada en curso.
            // `noopener` evita que la página destino acceda a `window.opener`.
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              color: 'primary.main',
              textDecorationColor: support.divider,
              fontWeight: 600,
              '&:hover': { textDecorationColor: 'inherit' },
            }}
          >
            200hub
          </Link>
        </Typography>
      </Container>
    </Box>
  );
}

export default Footer;
