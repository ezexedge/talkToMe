import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Nombre y foto de otro usuario, para mostrarlo en la sala. */
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

/**
 * Sincroniza el usuario logueado con la base apenas hay sesión.
 *
 * POR QUÉ HACE FALTA: el upsert en Postgres ocurre cuando el API valida un
 * token, y el API solo ve el token si el front le pega a una ruta protegida.
 * Como el Home es público (se ve el lobby sin sesión), un usuario podía
 * loguearse y quedarse en el lobby sin generar NUNCA una llamada autenticada —
 * y entonces no se guardaba en la base hasta que entrara a una sala.
 *
 * Este hook cierra ese hueco: llama a `GET /users/me` al iniciar sesión, que es
 * una ruta protegida y por lo tanto dispara el upsert. De paso devuelve la fila
 * ya persistida, útil para mostrar o depurar.
 */
export function useSyncUser() {
  const { isAuthenticated, getAccessTokenSilently } = useAuth0();
  const [dbUser, setDbUser] = useState<DbUser | null>(null);

  useEffect(() => {
    // Sin sesión no hay nada que sincronizar. No hace falta limpiar el estado
    // acá: al desloguearse el provider se re-monta y arranca en null.
    if (!isAuthenticated) return;

    // `cancelled` evita escribir estado si el componente se desmontó o la
    // sesión cambió mientras la request estaba en vuelo.
    let cancelled = false;

    void (async () => {
      try {
        const token = await getAccessTokenSilently();
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
        // Mejor esfuerzo: si falla, el usuario igual puede usar la app y el
        // upsert va a correr cuando entre a una sala.
        console.warn('[SYNC] No se pudo sincronizar el usuario:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getAccessTokenSilently]);

  return dbUser;
}

/**
 * Resuelve el perfil (nombre + foto) de otro usuario a partir de su `sub`.
 *
 * La señalización identifica al peer solo por su id: el `sub` de Auth0 viaja en
 * el `from` de cada mensaje SSE, pero nombre y foto no —y no deberían, porque
 * la señalización es para negociar la llamada, no para transportar perfiles—.
 * Este hook los busca en el API, que los sirve desde la caché de Redis.
 *
 * Devuelve null mientras no haya peer o no se haya resuelto todavía.
 */
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
        // `cancelled` evita pisar el perfil si el peer cambió mientras la
        // request estaba en vuelo (se fue uno y entró otro).
        if (found && !cancelled) setProfile(found);
      } catch {
        /* mejor esfuerzo: sin perfil se muestra el fallback genérico */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sub, isAuthenticated, getAccessTokenSilently]);

  return profile;
}
