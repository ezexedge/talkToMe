import { createTheme } from '@mui/material/styles';

/**
 * Tema "Warm Minimalism" (ver DESIGN.md en la raíz del repo).
 *
 * Dos reglas que definen el sistema y que MUI NO respeta por defecto:
 *
 *  1. SIN SOMBRAS. La profundidad se expresa por capas tonales (crema → blanco
 *     → bloque de color), no por elevación. MUI pone sombras en Paper, Card,
 *     Dialog, AppBar y Button, así que hay que anularlas explícitamente abajo.
 *  2. SENTENCE CASE. MUI pone `textTransform: uppercase` en los botones; acá
 *     el texto va tal cual se escribe.
 */

/** Colores de marca. Son la autoridad: los templates HTML de `resources/`
 *  usan un rojo ladrillo (#ae3123) que NO es el color de acción de la app. */
export const brand = {
  /** Acción primaria: crear room, unirse, spinners. */
  coral: '#FF6B57',
  coralDark: '#E85A47',
  /** Tipografía principal y jerarquía alta. */
  petrol: '#1C3A45',
  /** Fondo de la app. Nunca blanco puro. */
  cream: '#FFF6EE',
  /** Estados positivos: online, conectado, hay peer. */
  mint: '#8FD9C4',
  /** Texto sobre mint (el blanco no pasa contraste AA). */
  mintText: '#1A6A59',
  /** Superficies que deben "levantarse" sobre el crema. */
  white: '#FFFFFF',
  /** Bordes de inputs inactivos y deshabilitados. */
  border: '#E0E0E0',
} as const;

/** Colores de soporte, para estados que la paleta de marca no cubre. */
export const support = {
  textSecondary: '#59413D',
  surfaceRaised: '#F5ECE4',
  divider: '#EAE1D9',
  error: '#BA1A1A',
  errorContainer: '#FFDAD6',
  /** Countdown de expiración y acción de expulsar. */
  warning: '#D97706',
  warningContainer: '#FEF3C7',
} as const;

const FONT = '"Quicksand", system-ui, sans-serif';

export const theme = createTheme({
  // Unidad base de 4px: theme.spacing(2) = 8px, theme.spacing(6) = 24px.
  spacing: 4,
  shape: { borderRadius: 14 },
  palette: {
    mode: 'light',
    primary: {
      main: brand.coral,
      dark: brand.coralDark,
      contrastText: brand.white,
    },
    secondary: { main: brand.petrol, contrastText: brand.white },
    success: { main: brand.mint, contrastText: brand.mintText },
    warning: { main: support.warning, contrastText: brand.white },
    error: { main: support.error, contrastText: brand.white },
    background: { default: brand.cream, paper: brand.white },
    text: { primary: brand.petrol, secondary: support.textSecondary },
    divider: support.divider,
  },
  typography: {
    fontFamily: FONT,
    h1: {
      fontSize: 32,
      fontWeight: 700,
      lineHeight: '40px',
      letterSpacing: '-0.02em',
    },
    h2: {
      fontSize: 24,
      fontWeight: 700,
      lineHeight: '32px',
      letterSpacing: '-0.01em',
    },
    h3: { fontSize: 20, fontWeight: 600, lineHeight: '28px' },
    body1: { fontSize: 18, fontWeight: 500, lineHeight: '26px' },
    body2: { fontSize: 16, fontWeight: 500, lineHeight: '24px' },
    button: { fontSize: 14, fontWeight: 600, lineHeight: '20px' },
    caption: { fontSize: 14, fontWeight: 600, lineHeight: '20px' },
  },
  components: {
    // --- Anulación global de sombras (regla 1 del sistema) ---
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiCard: { defaultProps: { elevation: 0 } },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'transparent' },
      styleOverrides: { root: { boxShadow: 'none' } },
    },
    // En MUI v9 `PaperProps` se reemplazó por `slotProps.paper`.
    MuiDialog: { defaultProps: { slotProps: { paper: { elevation: 0 } } } },

    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          // Regla 2: sentence case, no el uppercase por defecto de MUI.
          textTransform: 'none',
          borderRadius: 14,
          minHeight: 48,
          paddingInline: 24,
          boxShadow: 'none',
          '&:hover': { boxShadow: 'none' },
        },
        // Botón secundario: borde de 2px que no salta al hacer hover.
        outlined: { borderWidth: 2, '&:hover': { borderWidth: 2 } },
      },
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: brand.white,
          borderRadius: 14,
          '& fieldset': { borderColor: brand.border },
          // En focus el borde engorda a 2px y se pinta de coral.
          '&.Mui-focused fieldset': {
            borderWidth: 2,
            borderColor: brand.coral,
          },
        },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, borderRadius: 9999 },
      },
    },

    MuiAlert: {
      defaultProps: { variant: 'standard' },
      styleOverrides: { root: { borderRadius: 14, fontWeight: 600 } },
    },
  },
});
