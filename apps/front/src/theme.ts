import { createTheme } from '@mui/material/styles';

export const brand = {
  coral: '#FF6B57',
  coralDark: '#E85A47',
  petrol: '#1C3A45',
  cream: '#FFF6EE',
  mint: '#8FD9C4',
  mintText: '#1A6A59',
  white: '#FFFFFF',
  border: '#E0E0E0',
} as const;

export const support = {
  textSecondary: '#59413D',
  surfaceRaised: '#F5ECE4',
  divider: '#EAE1D9',
  error: '#BA1A1A',
  errorContainer: '#FFDAD6',
  warning: '#D97706',
  warningContainer: '#FEF3C7',
} as const;

const FONT = '"Quicksand", system-ui, sans-serif';

export const theme = createTheme({
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
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiCard: { defaultProps: { elevation: 0 } },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'transparent' },
      styleOverrides: { root: { boxShadow: 'none' } },
    },
    MuiDialog: { defaultProps: { slotProps: { paper: { elevation: 0 } } } },

    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          textTransform: 'none',
          borderRadius: 14,
          minHeight: 48,
          paddingInline: 24,
          boxShadow: 'none',
          '&:hover': { boxShadow: 'none' },
        },
        outlined: { borderWidth: 2, '&:hover': { borderWidth: 2 } },
      },
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: brand.white,
          borderRadius: 14,
          '& fieldset': { borderColor: brand.border },
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
