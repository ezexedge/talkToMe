import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export interface PeerProfile {
  sub: string;
  name: string | null;
  picture: string | null;
}

export interface DbUser {
  id: string;
  auth0Id: string;
  email: string | null;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
}

export function useSyncUser() {
  const { isAuthenticated, getAccessTokenSilently } = useAuth0();
  const [dbUser, setDbUser] = useState<DbUser | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;

    void (async () => {
      try {
        const token = await getAccessTokenSilently();
        // TEMPORAL — diagnóstico: ver si el token llega vacío y por qué.
        console.log('[SYNC] token length:', token?.length ?? 'NULL/UNDEFINED');
        console.log('[SYNC] token starts:', token?.slice(0, 25) ?? '(nada)');
        const res = await fetch(`${API_URL}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          console.warn('[SYNC] /users/me respondió', res.status);
          return;
        }
        const user = (await res.json()) as DbUser;
        if (!cancelled) {
          setDbUser(user);
          console.log('[SYNC] 👤 Usuario sincronizado con la DB:', user);
        }
      } catch (e) {
        // El catch tragaba el motivo real; ahora se imprime completo.
        console.error('[SYNC] getAccessTokenSilently FALLÓ:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getAccessTokenSilently]);

  return dbUser;
}

export function usePeerProfile(sub: string | null): PeerProfile | null {
  const { isAuthenticated, getAccessTokenSilently } = useAuth0();
  const [profile, setProfile] = useState<PeerProfile | null>(null);

  useEffect(() => {
    if (!sub || !isAuthenticated) return;

    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessTokenSilently();
        const res = await fetch(
          `${API_URL}/users/profiles?subs=${encodeURIComponent(sub)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;
        const [found] = (await res.json()) as PeerProfile[];
        if (found && !cancelled) setProfile(found);
      } catch {
        /* ignored */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sub, isAuthenticated, getAccessTokenSilently]);

  return profile;
}
