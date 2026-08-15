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
      onRedirectCallback={(appState) => {
        const target = appState?.returnTo ?? '/';
        window.history.replaceState({}, '', target);
      }}
    >
      <SyncUserOnLogin />
      {children}
    </Auth0Provider>
  );
}

function SyncUserOnLogin() {
  useSyncUser();
  return null;
}

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
    return <RedirectToLogin />;
  }

  return <>{children}</>;
}

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
