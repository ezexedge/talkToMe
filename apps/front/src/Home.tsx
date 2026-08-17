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

const POLL_MS = 5_000;

const LEAVE_SETTLE_MS = 6_000;

const chipSx = (active: boolean) => ({
  bgcolor: active ? 'primary.main' : support.surfaceRaised,
  color: active ? brand.white : 'text.secondary',
  fontWeight: active ? 600 : 400,
  transition: 'background-color 120ms',
  '&:hover': {
    bgcolor: active ? 'primary.dark' : support.divider,
  },
});

interface RoomMember {
  sub: string;
  name: string | null;
  picture: string | null;
}

interface RoomInfo {
  roomId: string;
  count: number;
  members: RoomMember[];
  expiresInSeconds: number | null;
  isOwner: boolean;
}

function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [roomToDelete, setRoomToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [toast, setToast] = useState<{
    severity: 'error' | 'success' | 'info';
    message: string;
    // Room a la que ofrecer ir desde el propio toast (el 409 de "ya tenés una
    // room"): sin esto el usuario queda trabado, porque una room vacía no
    // aparece en la lista de activas y no tiene cómo llegar a ella.
    actionRoomId?: string;
  } | null>(null);

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

  const kickedFrom = (location.state as { kickedFrom?: string } | null)
    ?.kickedFrom;

  const fetchRooms = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (isAuthenticated) {
        try {
          headers.Authorization = `Bearer ${await getAccessTokenSilently()}`;
        } catch {
        /* ignored */
      }
      }
      const res = await fetch(`${API_URL}/signaling/rooms`, { headers });
      if (res.ok) setRooms((await res.json()) as RoomInfo[]);
    } catch {
        /* ignored */
      }
  }, [isAuthenticated, getAccessTokenSilently]);

  useEffect(() => {
    void fetchRooms();
    const id = setInterval(() => void fetchRooms(), POLL_MS);

    const settle = setTimeout(() => void fetchRooms(), LEAVE_SETTLE_MS);

    return () => {
      clearInterval(id);
      clearTimeout(settle);
    };
  }, [fetchRooms, location.key]);

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

  useEffect(() => {
    const onFocus = () => void fetchRooms();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchRooms();
    };
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
      setRooms((prev) => prev.filter((r) => r.roomId !== roomToDelete));
    } catch {
      setToast({ severity: 'error', message: 'Could not reach the server.' });
    } finally {
      setDeleting(false);
      setRoomToDelete(null);
    }
  }, [roomToDelete, getAccessTokenSilently]);

  const createRoom = useCallback(
    async (id: string) => {
      // El micrófono ANTES del POST: si el usuario bloquea el permiso, no se
      // creó nada que limpiar. Al revés (crear y después pedir permiso) la room
      // queda huérfana —invisible en la lista porque está vacía, pero viva en
      // Redis— y el 409 bloquea crear otra hasta que expire el TTL.
      //
      // Las pistas se cortan enseguida: acá solo interesa saber si hay permiso.
      // useAudioCall vuelve a pedirlas al entrar, y para entonces el navegador
      // ya recordó la decisión, así que no hay segundo prompt.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        setToast({
          severity: 'error',
          message:
            'Microphone access is required to create a room. Allow it in your browser and try again.',
        });
        return;
      }

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
          // El server manda el roomId de la room que ya existe. Se ofrece ir a
          // ella en vez de dejar al usuario en un callejón sin salida: la room
          // puede estar vacía y por eso NO aparecer en la lista de activas.
          const body = (await res.json().catch(() => null)) as {
            roomId?: string;
          } | null;

          setToast({
            severity: 'error',
            message: body?.roomId
              ? `You already have a room open (${body.roomId}).`
              : 'You can only have one room at a time. Delete your existing room before creating a new one.',
            actionRoomId: body?.roomId,
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
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
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
        <Box
          sx={{
            bgcolor: 'background.paper',
            borderRadius: '24px',
            border: '1px solid',
            borderColor: 'divider',
            p: { xs: 6, md: 10 },
            mb: 12,
            display: 'flex',
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
              // Se chequea la sesión ANTES de abrir el modal: sin esto el
              // usuario completa el formulario y recién ahí falla, porque
              // getAccessTokenSilently() tira y cae en el catch genérico
              // ("Could not reach the server"), que además culpa al server.
              onClick={() => {
                if (!isAuthenticated) {
                  setToast({
                    severity: 'info',
                    message: 'You must be logged in to create a room.',
                  });
                  return;
                }
                setCreateOpen(true);
              }}
              sx={{ mt: 6 }}
            >
              Create room
            </Button>
          </Box>

          <HeroDecoration />
        </Box>
        <Typography variant="h2">Active rooms</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Join a conversation that is already happening.
        </Typography>
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
      <CreateRoomModal
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={createRoom}
      />
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
            action={
              toast.actionRoomId ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    const target = toast.actionRoomId;
                    setToast(null);
                    if (target) goToRoom(target);
                  }}
                >
                  Go to it
                </Button>
              ) : undefined
            }
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
