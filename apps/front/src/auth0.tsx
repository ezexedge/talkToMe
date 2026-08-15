import { useEffect, type ReactNode } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useSyncUser } from './useSyncUser';

const domain = import.meta.env.VITE_AUTH0_DOMAIN as string;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string;

/**
 * Provider de Auth0 para toda la app.
 *
 * `audience` es OBLIGATORIO: sin él Auth0 devuelve un access token OPACO (una
 * cadena que solo Auth0 sabe leer) y el API no podría validarlo. Con audience
 * emite un JWT firmado con RS256, que es lo que la JwtStrategy del backend
 * verifica contra el JWKS.
 *
 * `cacheLocation: 'localstorage'` + `useRefreshTokens` hacen que la sesión
 * sobreviva al F5 sin un viaje de ida y vuelta a Auth0. Con el default
 * (memoria) cada recarga dispara un redirect silencioso, que los navegadores
 * con bloqueo de cookies de terceros (Safari, Firefox) rompen — y ahí el
 * usuario aparecería deslogueado cada vez que recarga la sala.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
        scope: 'openid profile email',
      }}
      cacheLocation="localstorage"
      useRefreshTokens
      /**
       * Al volver del login, Auth0 siempre aterriza en el origin (`/`), porque
       * es la única callback URL registrada. Este handler restaura la ruta que
       * el usuario quería antes de que lo mandáramos a Google (la guarda
       * RequireAuth en `appState.returnTo`), así que entrar a /room/abc sin
       * sesión te deja en /room/abc y no en el lobby.
       *
       * Se usa `replace` para que el "atrás" del navegador no vuelva a la
       * pantalla intermedia del login.
       */
      onRedirectCallback={(appState) => {
        const target = appState?.returnTo ?? '/';
        window.history.replaceState({}, '', target);
      }}
    >
      {/* Va DENTRO del provider (necesita useAuth0) y envolviendo a toda la
          app, para que el usuario se guarde en la base apenas inicia sesión,
          sin depender de que entre a una sala. */}
      <SyncUserOnLogin />
      {children}
    </Auth0Provider>
  );
}

/**
 * Dispara la sincronización con la base al iniciar sesión. No renderiza nada:
 * existe solo por su efecto.
 */
function SyncUserOnLogin() {
  useSyncUser();
  return null;
}

/**
 * Botón de login con Google.
 *
 * `connection: 'google-oauth2'` salta la pantalla de selección de Auth0 y va
 * directo a Google. Si se quitara, aparecería el Universal Login con todas las
 * conexiones habilitadas en el tenant.
 */
export function LoginButton() {
  const { loginWithRedirect } = useAuth0();
  return (
    <Button
      variant="contained"
      onClick={() =>
        void loginWithRedirect({
          authorizationParams: { connection: 'google-oauth2' },
        })
      }
    >
      Sign in with Google
    </Button>
  );
}

export function LogoutButton() {
  const { logout } = useAuth0();
  return (
    <Button
      variant="outlined"
      size="small"
      onClick={() =>
        void logout({ logoutParams: { returnTo: window.location.origin } })
      }
    >
      Sign out
    </Button>
  );
}

/**
 * Puerta de entrada: envuelve lo que exija sesión.
 *
 * Hay tres estados y los tres importan:
 *  - `isLoading`: Auth0 todavía está restaurando la sesión. NO se puede decidir
 *    aún; mostrar el login acá haría parpadear la pantalla en cada recarga.
 *  - autenticado: se renderiza el contenido.
 *  - no autenticado: se ofrece el login.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, error } = useAuth0();

  if (isLoading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <Stack sx={{ alignItems: 'center', gap: 2 }}>
          <Typography color="error">Sign-in error: {error.message}</Typography>
          <LoginButton />
        </Stack>
      </Box>
    );
  }

  if (!isAuthenticated) {
    // Sin sesión → derecho a Google, sin pantalla intermedia.
    //
    // `returnTo` guarda la ruta actual para volver acá después del login (lo
    // usa onRedirectCallback en el AuthProvider). Sin esto, Auth0 devolvería al
    // usuario a "/" y perdería la sala a la que estaba entrando.
    return <RedirectToLogin />;
  }

  return <>{children}</>;
}

/**
 * Dispara el login y muestra un spinner mientras el navegador se va a Auth0.
 *
 * El `loginWithRedirect` va en un effect y no en el render porque navegar es un
 * side-effect: hacerlo durante el render puede ejecutarse dos veces (StrictMode,
 * renders descartados) y disparar dos redirects.
 */
function RedirectToLogin() {
  const { loginWithRedirect } = useAuth0();

  useEffect(() => {
    void loginWithRedirect({
      appState: { returnTo: window.location.pathname + window.location.search },
      authorizationParams: { connection: 'google-oauth2' },
    });
  }, [loginWithRedirect]);

  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
      <Stack sx={{ alignItems: 'center', gap: 2 }}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">
          Redirecting to sign in…
        </Typography>
      </Stack>
    </Box>
  );
}
