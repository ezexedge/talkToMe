import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import Avatar from '@mui/material/Avatar';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CreateRoomModal from './CreateRoomModal';
import Footer from './Footer';
import { LoginButton, LogoutButton } from './auth0';
import HeroDecoration from './HeroDecoration';
import { LEVELS, levelFromRoomId, type LevelValue } from './levels';
import { brand, support } from './theme';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Cada cuánto se refresca la lista de rooms del lobby. */
const POLL_MS = 10_000;

/**
 * Espera antes del re-fetch que corre al entrar al lobby.
 *
 * Tiene que ser MAYOR que el DISCONNECT_GRACE_MS del server (5s), que es lo que
 * tarda en dar de baja a un cliente cuyo SSE se cortó sin `leave` (salir con el
 * "atrás" del navegador). Si fuera menor, leeríamos la ocupación de antes de la
 * baja y seguiríamos mostrando el dato viejo.
 */
const LEAVE_SETTLE_MS = 6_000;

/**
 * Estilo de los chips del filtro de nivel.
 *
 * Seleccionar un filtro ES una acción, así que el chip activo va en coral con
 * texto blanco (DESIGN.md: "el Coral es solo para acciones", "texto sobre
 * Coral: siempre #FFFFFF"). En reposo usa la superficie elevada #F5ECE4 con
 * texto secundario, igual que el resto de los chips de la app.
 */
const chipSx = (active: boolean) => ({
  bgcolor: active ? 'primary.main' : support.surfaceRaised,
  color: active ? brand.white : 'text.secondary',
  fontWeight: active ? 600 : 400,
  transition: 'background-color 120ms',
  '&:hover': {
    bgcolor: active ? 'primary.dark' : support.divider,
  },
});

/** Perfil de un participante, para pintar su avatar en la card. */
interface RoomMember {
  sub: string;
  name: string | null;
  picture: string | null;
}

interface RoomInfo {
  roomId: string;
  count: number;
  /**
   * Quiénes están adentro. Llega VACÍO si no hay sesión: el server solo revela
   * identidades a usuarios logueados (ver el lobby es público, saber quién está
   * en llamada no).
   */
  members: RoomMember[];
  /** Segundos que le quedan a una room VACÍA antes de que Redis la borre (null si tiene gente). */
  expiresInSeconds: number | null;
  /**
   * ¿SOY el dueño de esta sala? Lo resuelve el server contra mi token; el front
   * nunca ve el `sub` del creador. Solo controla si se muestra el botón de
   * borrar: el permiso real lo revalida el server en el DELETE.
   */
  isOwner: boolean;
}

/**
 * Home — el lobby. Lista las rooms activas (con polling) y permite crear/unirse.
 * Al entrar a una room navega a /room/:roomId (URL real).
 */
function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  // Sala que el dueño pidió eliminar (abre el modal de confirmación).
  const [roomToDelete, setRoomToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Aviso efímero (crear sala rechazada, borrado ok/fallido…).
  const [toast, setToast] = useState<{
    severity: 'error' | 'success';
    message: string;
  } | null>(null);

  // Niveles activos del filtro. Set vacío = "Todos" = no se filtra nada.
  // Es multi-selección: clickear un chip lo agrega, volver a clickearlo lo
  // saca, y si sacás el último se vuelve solo al estado "Todos".
  const [levelFilter, setLevelFilter] = useState<Set<LevelValue>>(new Set());

  const {
    user,
    isAuthenticated,
    isLoading: authLoading,
    getAccessTokenSilently,
  } = useAuth0();

  const toggleLevel = useCallback((value: LevelValue) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (!next.delete(value)) next.add(value);
      return next;
    });
  }, []);

  // Room de la que nos acaban de expulsar (la manda Room al navegar acá).
  const kickedFrom = (location.state as { kickedFrom?: string } | null)
    ?.kickedFrom;

  const fetchRooms = useCallback(async () => {
    try {
      // El listado es público, así que sin sesión se llama sin token y se ven
      // las salas igual (pero sin avatares). CON sesión mandamos el token, y
      // ahí el server incluye los perfiles de quienes están adentro.
      const headers: HeadersInit = {};
      if (isAuthenticated) {
        try {
          headers.Authorization = `Bearer ${await getAccessTokenSilently()}`;
        } catch {
          /* si el token falla, seguimos como anónimos */
        }
      }
      const res = await fetch(`${API_URL}/signaling/rooms`, { headers });
      if (res.ok) setRooms((await res.json()) as RoomInfo[]);
    } catch {
      /* best-effort; reintenta en el próximo tick */
    }
  }, [isAuthenticated, getAccessTokenSilently]);

  // Polling del lobby. A 10s la lista se siente viva sin castigar al server:
  // el endpoint solo hace un SCAN y unos SCARD en Redis.
  //
  // `location.key` en las deps: cambia en CADA navegación, incluido volver
  // atrás desde una room. Sin eso, entrar al lobby por el "atrás" del navegador
  // o por el botón de colgar mostraba la lista vieja: no hay `focus` ni
  // `visibilitychange` que disparen (la pestaña nunca se ocultó), y justo la
  // room de la que venís acaba de cambiar de ocupación.
  useEffect(() => {
    void fetchRooms();
    const id = setInterval(() => void fetchRooms(), POLL_MS);

    // Segundo fetch diferido, para el caso de salir de una room con el "atrás"
    // del navegador en vez del botón de colgar.
    //
    // Ahí no hay POST /leave: solo se corta el SSE, y el server espera una
    // gracia (5s) antes de darte de baja —esa ventana existe para que un F5 no
    // te eche de tu propia room—. O sea que el fetch de recién todavía te ve
    // adentro. Este re-fetch corre pasada esa ventana y muestra la ocupación
    // real, sin esperar los 10s del polling.
    const settle = setTimeout(() => void fetchRooms(), LEAVE_SETTLE_MS);

    return () => {
      clearInterval(id);
      clearTimeout(settle);
    };
  }, [fetchRooms, location.key]);

  // La cuenta regresiva de borrado la manda el server (TTL real de Redis), pero
  // el polling es cada 10s: si solo dependiéramos de él el número no se movería
  // en toda la ventana de gracia. Así que entre fetch y fetch lo bajamos 1 por
  // segundo acá; el próximo fetch lo re-sincroniza con Redis (que es la verdad).
  //
  // Al llegar a 0 la room ya expiró en Redis, pero el próximo fetch puede tardar
  // hasta 10s: la sacamos de la lista nosotros para no mostrar una room muerta.
  useEffect(() => {
    const id = setInterval(() => {
      setRooms((prev) =>
        prev
          .map((r) =>
            r.expiresInSeconds !== null && r.expiresInSeconds > 0
              ? { ...r, expiresInSeconds: r.expiresInSeconds - 1 }
              : r,
          )
          .filter((r) => r.expiresInSeconds === null || r.expiresInSeconds > 0),
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Aun con 10s de polling, volver al lobby desde una room puede mostrar datos
  // viejos unos segundos. Refrescamos al recuperar el foco / volver a la
  // pestaña, que es justo cuando el usuario está mirando la lista.
  useEffect(() => {
    const onFocus = () => void fetchRooms();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchRooms();
    };
    // `pageshow` con `persisted === true`: la página volvió del back-forward
    // cache, o sea que el navegador la restauró TAL CUAL estaba, sin re-montar
    // React ni correr los effects. Es el caso del "atrás" tras haber salido del
    // sitio, y sin esto se ve la lista congelada de cuando te fuiste.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void fetchRooms();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [fetchRooms]);

  const goToRoom = useCallback(
    (id: string) => navigate(`/room/${encodeURIComponent(id)}`),
    [navigate],
  );

  /**
   * Eliminar una sala desde el lobby. El server revalida que seas el dueño y
   * que no haya nadie adentro, así que esto es solo la parte de UI.
   */
  const deleteRoom = useCallback(async () => {
    if (!roomToDelete) return;
    setDeleting(true);
    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(
        `${API_URL}/signaling/rooms/${encodeURIComponent(roomToDelete)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setToast({
          severity: 'error',
          message: body.message ?? 'Could not delete the room.',
        });
        return;
      }
      setToast({ severity: 'success', message: 'Room deleted.' });
      // Se saca de la lista al instante en vez de esperar el próximo polling,
      // para que la acción se sienta inmediata.
      setRooms((prev) => prev.filter((r) => r.roomId !== roomToDelete));
    } catch {
      setToast({ severity: 'error', message: 'Could not reach the server.' });
    } finally {
      setDeleting(false);
      setRoomToDelete(null);
    }
  }, [roomToDelete, getAccessTokenSilently]);

  /**
   * Crear una sala: primero se reserva en el server, y solo si acepta se navega.
   *
   * El server es quien impone "una sala creada por usuario". Se valida ANTES de
   * entrar y no al abrir el SSE porque ahí el cliente ya estaría a mitad de la
   * negociación y el rechazo llegaría tarde y confuso.
   */
  const createRoom = useCallback(
    async (id: string) => {
      try {
        const token = await getAccessTokenSilently();
        const res = await fetch(`${API_URL}/signaling/rooms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ roomId: id }),
        });

        if (res.status === 409) {
          // Ya tiene una sala creada. No se nombra cuál: el usuario sabe cuál
          // es la suya y el id generado (`beginner-food-x2y3`) no le dice nada.
          setToast({
            severity: 'error',
            message:
              'You can only have one room at a time. Delete your existing room before creating a new one.',
          });
          return;
        }

        if (!res.ok) {
          setToast({ severity: 'error', message: 'Could not create the room.' });
          return;
        }

        goToRoom(id);
      } catch {
        setToast({ severity: 'error', message: 'Could not reach the server.' });
      }
    },
    [getAccessTokenSilently, goToRoom],
  );

  // Con el filtro vacío se muestran todas (incluidas las rooms sin nivel
  // reconocible, creadas a mano por URL). Con niveles activos, esas quedan
  // fuera: no hay forma de saber a qué nivel pertenecen.
  const visibleRooms =
    levelFilter.size === 0
      ? rooms
      : rooms.filter((r) => {
          const level = levelFromRoomId(r.roomId);
          return level !== null && levelFilter.has(level);
        });

  return (
    <Box
      sx={{
        // Columna flex de alto completo: así el `mt: auto` del footer lo
        // empuja al fondo aunque haya pocas salas y la página no llene la
        // pantalla (si no, quedaría flotando a media altura).
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      {/* Header: solo la marca. Sin sombra ni borde inferior (capas tonales). */}
      <Box component="header" sx={{ py: 6, px: { xs: 5, md: 12 } }}>
        <Container disableGutters maxWidth="lg">
          <Stack
            sx={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
            }}
          >
            {/*
              Igual que el favicon: todo en coral salvo la SEGUNDA T, que va
              en menta (#8FD9C4) — el MISMO tono que la T del icono.

              Nota de accesibilidad: ese menta sobre el crema da 1.53:1 de
              contraste, por debajo del 3:1 que pide WCAG para texto grande. Se
              mantiene por decisión de marca (que el logotipo coincida con el
              favicon); si alguna vez hay que cumplir la norma, el tema ya trae
              `mintText` (#1A6A59), que da 6.05:1.

              `aria-label` para que un lector de pantalla anuncie "TalkToMe" de
              corrido y no la palabra partida por el span.
            */}
            <Typography
              variant="h1"
              aria-label="TalkToMe"
              sx={{ color: 'primary.main' }}
            >
              Talk
              <Box component="span" sx={{ color: brand.mint }}>
                T
              </Box>
              oMe
            </Typography>
            {/* El Home es público, así que hay dos casos: con sesión mostramos
                el avatar y "salir"; sin sesión, el botón de login. Mientras
                Auth0 restaura la sesión no mostramos ninguno de los dos, para
                que no aparezca "iniciar sesión" un instante y luego el avatar. */}
            {!authLoading && (
              <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                {isAuthenticated ? (
                  <>
                    <Avatar
                      src={user?.picture ?? undefined}
                      alt={user?.name ?? 'user'}
                      sx={{ width: 36, height: 36 }}
                    >
                      {user?.name?.[0]?.toUpperCase()}
                    </Avatar>
                    <Typography
                      variant="body2"
                      sx={{ display: { xs: 'none', sm: 'block' } }}
                    >
                      {user?.name ?? user?.email}
                    </Typography>
                    <LogoutButton />
                  </>
                ) : (
                  <LoginButton />
                )}
              </Stack>
            )}
          </Stack>
        </Container>
      </Box>

      {/* `flexGrow: 1` para que el contenido ocupe el alto disponible y empuje
          el footer al fondo. El `pb` baja de 16 a 12: el footer ya aporta su
          propio aire, y mantenerlo dejaba un hueco notorio antes del borde. */}
      <Container
        maxWidth="lg"
        sx={{ px: { xs: 5, md: 12 }, pb: 12, flexGrow: 1 }}
      >
        {kickedFrom && (
          <Alert
            severity="error"
            sx={{ mb: 6, bgcolor: support.errorContainer, color: 'error.main' }}
          >
            You were removed from the room <strong>{kickedFrom}</strong>.
          </Alert>
        )}

        {/* --- Hero --- */}
        <Box
          sx={{
            bgcolor: 'background.paper',
            borderRadius: '24px',
            border: '1px solid',
            borderColor: 'divider',
            p: { xs: 6, md: 10 },
            mb: 12,
            display: 'flex',
            // Desktop: dos columnas (texto | decoración), como el diseño
            // original. Mobile: apilado, con la decoración DEBAJO del texto
            // y el botón, ocupando todo el ancho.
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: { xs: 8, md: 6 },
          }}
        >
          <Box sx={{ flex: 1 }}>
            <Typography variant="h1">
              1-on-1 English speaking practice
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 3 }}>
              Pick your level and a topic, and get matched into a private
              audio room with one other learner. Just two of you — no
              audience, no video.
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setCreateOpen(true)}
              sx={{ mt: 6 }}
            >
              Create room
            </Button>
          </Box>

          <HeroDecoration />
        </Box>

        {/* --- Rooms activas --- La sección y el filtro se muestran SIEMPRE,
            aunque no haya ninguna room: el lobby vacío igual tiene que
            explicar qué va acá y dejar los niveles a la vista. --- */}
        <Typography variant="h2">Active rooms</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Join a conversation that is already happening.
        </Typography>

        {/* Filtro por nivel. "Todos" no es un nivel más: es el estado vacío
            del filtro, así que se pinta activo cuando no hay ninguno
            seleccionado y al clickearlo limpia la selección. */}
        <Stack
          direction="row"
          sx={{ mt: 4, flexWrap: 'wrap', gap: 2 }}
          role="group"
          aria-label="Filter rooms by level"
        >
          <Chip
            label="All"
            clickable
            aria-pressed={levelFilter.size === 0}
            onClick={() => setLevelFilter(new Set())}
            sx={chipSx(levelFilter.size === 0)}
          />
          {LEVELS.map((l) => {
            const active = levelFilter.has(l.value);
            return (
              <Chip
                key={l.value}
                label={l.label}
                clickable
                aria-pressed={active}
                onClick={() => toggleLevel(l.value)}
                sx={chipSx(active)}
              />
            );
          })}
        </Stack>

        {/* Estado vacío: solo el mensaje. El botón de crear ya está en el hero,
            justo arriba, y repetirlo acá duplicaría la misma acción. Se
            distinguen los dos casos porque "no hay rooms" y "el filtro las
            escondió" son situaciones distintas para el usuario. */}
        {visibleRooms.length === 0 && (
          <Box
            sx={{
              mt: 6,
              p: 8,
              borderRadius: '20px',
              border: '1px dashed',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              textAlign: 'center',
            }}
          >
            <Typography variant="body1" color="text.secondary">
              {rooms.length === 0
                ? 'No rooms available at the moment.'
                : 'No rooms available for the selected levels.'}
            </Typography>
          </Box>
        )}

        {visibleRooms.length > 0 && (
          <Box
            sx={{
              mt: 6,
              display: 'grid',
              gap: 6,
              gridTemplateColumns: {
                xs: '1fr',
                sm: 'repeat(2, 1fr)',
                md: 'repeat(3, 1fr)',
              },
            }}
          >
            {visibleRooms.map((r) => {
              const full = r.count >= 2;
              // Una room vacía sigue listada mientras le queda TTL, por si
              // querés volver a entrar, y desaparece sola al expirar. NO se
              // muestra la cuenta regresiva: cada cliente la estima local y
              // los números no coinciden entre pestañas.
              return (
                <Box
                  key={r.roomId}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    p: 6,
                    borderRadius: '20px',
                    border: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'background.paper',
                    transition: 'border-color 120ms',
                    '&:hover': { borderColor: 'secondary.main' },
                  }}
                >
                  <Stack
                    direction="row"
                    sx={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 2,
                    }}
                  >
                    {/*
                      El chip muestra el NIVEL de la sala, no su id.
                      Ahora que la card no lleva el nombre de la room, el nivel
                      es lo que queda para decidir a cuál entrar — y es el mismo
                      criterio por el que se filtra arriba. Si el id no sigue el
                      formato `{nivel}-...`, se cae a Available/Full.
                    */}
                    <Chip
                      size="small"
                      label={
                        LEVELS.find(
                          (l) => l.value === levelFromRoomId(r.roomId),
                        )?.label ?? (full ? 'Full' : 'Available')
                      }
                      sx={{
                        bgcolor: full
                          ? support.errorContainer
                          : support.surfaceRaised,
                        color: full ? 'error.main' : 'text.secondary',
                      }}
                    />
                    <Stack
                      direction="row"
                      sx={{
                        alignItems: 'center',
                        gap: 1.5,
                        bgcolor: support.surfaceRaised,
                        borderRadius: 9999,
                        px: 3,
                        py: 1,
                      }}
                    >
                      <Box
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          bgcolor: full ? support.error : brand.mint,
                        }}
                      />
                      <Typography
                        variant="caption"
                        color="text.secondary"
                      >{`${r.count}/2`}</Typography>
                    </Stack>
                  </Stack>

                  {/*
                    Participantes: el contenido principal de la card.
                    Reemplaza al nombre de la room — lo que importa al elegir a
                    dónde entrar es CON QUIÉN vas a hablar, no cómo se llama la
                    sala.

                    Se renderizan SIEMPRE los 2 lugares: el ocupado con su
                    avatar y nombre, y el libre como un círculo punteado. Así la
                    card no cambia de alto según cuánta gente haya, y se ve de
                    un vistazo si queda lugar.
                  */}
                  <Stack
                    direction="row"
                    sx={{
                      justifyContent: 'center',
                      alignItems: 'flex-start',
                      gap: 4,
                      flexGrow: 1,
                      py: 2,
                    }}
                  >
                    {[0, 1].map((slot) => {
                      const m = r.members[slot];
                      return (
                        <Stack
                          key={m?.sub ?? `empty-${slot}`}
                          sx={{
                            alignItems: 'center',
                            gap: 1.5,
                            // Acompaña al avatar de 88px y deja aire para el
                            // nombre debajo sin que se corte a la primera.
                            width: 128,
                          }}
                        >
                          {m ? (
                            <Avatar
                              src={m.picture ?? undefined}
                              alt={m.name ?? 'Participant'}
                              sx={{ width: 88, height: 88, fontSize: 34 }}
                            >
                              {m.name?.[0]?.toUpperCase()}
                            </Avatar>
                          ) : (
                            // Lugar libre: círculo punteado, sin ícono ni
                            // inicial, para que se lea como "acá falta alguien".
                            <Box
                              sx={{
                                width: 88,
                                height: 88,
                                borderRadius: '50%',
                                border: '2px dashed',
                                borderColor: 'divider',
                              }}
                            />
                          )}
                          <Typography
                            variant="caption"
                            align="center"
                            color={m ? 'text.primary' : 'text.secondary'}
                            sx={{
                              lineHeight: 1.3,
                              // Nombres largos se cortan a 2 líneas en vez de
                              // desbalancear la altura de la card.
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {m
                              ? (m.name ?? 'Participant')
                              : isAuthenticated
                                ? 'Free seat'
                                : ''}
                          </Typography>
                        </Stack>
                      );
                    })}
                  </Stack>

                  <Divider />

                  <Button
                    fullWidth
                    variant={full ? 'outlined' : 'contained'}
                    disabled={full}
                    onClick={() => goToRoom(r.roomId)}
                  >
                    {full ? 'Full' : 'Join'}
                  </Button>

                  {/* Eliminar: SOLO para el dueño, y solo si la sala está
                      vacía. Con gente adentro se deshabilita en vez de
                      ocultarse, para que quede claro por qué no se puede (el
                      server rechaza el borrado igual: esto es la UI). */}
                  {r.isOwner && (
                    <Button
                      fullWidth
                      variant="text"
                      color="error"
                      size="small"
                      startIcon={<DeleteOutlineIcon />}
                      disabled={r.count > 0}
                      title={
                        r.count > 0
                          ? 'You can only delete the room when nobody is in it'
                          : undefined
                      }
                      onClick={() => setRoomToDelete(r.roomId)}
                    >
                      Delete
                    </Button>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
      </Container>

      {/* `key` ligado a `createOpen`: al abrir, React remonta el modal y su
          campo arranca vacío, sin arrastrar lo tipeado en un intento anterior
          que se canceló (y sin necesidad de un effect que resetee el state). */}
      <CreateRoomModal
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={createRoom}
      />

      {/* Confirmación de borrado: es irreversible, así que no va de un clic. */}
      <Dialog
        open={roomToDelete !== null}
        onClose={() => !deleting && setRoomToDelete(null)}
      >
        <DialogTitle>Delete this room?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This room will be removed permanently and will disappear from the
            lobby. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5, gap: 2 }}>
          <Button onClick={() => setRoomToDelete(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void deleteRoom()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete room'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Avisos efímeros. `autoHideDuration` para que no quede tapando la UI;
          el usuario también puede cerrarlo. */}
      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert
            severity={toast.severity}
            onClose={() => setToast(null)}
            variant="filled"
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>

      <Footer />
    </Box>
  );
}

export default Home;
