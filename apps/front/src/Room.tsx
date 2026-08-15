import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import CallEndIcon from '@mui/icons-material/CallEnd';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import PersonIcon from '@mui/icons-material/Person';
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { keyframes } from '@mui/material/styles';
import AudioWave from './AudioWave';
import { usePeerProfile } from './useSyncUser';
import { useAudioCall, type CallStatus } from './useAudioCall';
import { brand, support } from './theme';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  'room-full': 'Room full',
  'already-in-room': 'Already in another room',
  error: 'Error',
};

/** Anillos concéntricos que se expanden mientras el peer tiene audio activo. */
const pulseRing = keyframes`
  0% { transform: scale(1); opacity: 0.8; }
  100% { transform: scale(1.15); opacity: 0; }
`;

/**
 * Room — la pantalla de la llamada. Toma el roomId de la URL (/room/:roomId),
 * se une automáticamente al montar y cuelga al desmontar / volver.
 */
function Room() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  // Perfil propio, para mostrar mi foto en mi tarjeta.
  const { user, getAccessTokenSilently } = useAuth0();

  // Modal de confirmación para eliminar la sala.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const {
    status,
    error,
    muted,
    peerConnected,
    peerId,
    peerMuted,
    kicked,
    isOwner,
    clientId,
    remoteAudioRef,
    join,
    hangup,
    kick,
    toggleMute,
  } = useAudioCall(roomId);

  // Nombre y foto del otro participante. La señalización solo nos da su `sub`
  // (en el `from` de los mensajes SSE); el perfil se resuelve contra el API,
  // que lo sirve desde la caché de Redis.
  const peerProfile = usePeerProfile(peerId);

  // Unirse una sola vez al montar (StrictMode está desactivado en main.tsx,
  // así que esto corre una única vez).
  const startedRef = useRef(false);
  useEffect(() => {
    if (!roomId || startedRef.current) return;
    startedRef.current = true;
    void join();
    // hangup al desmontar (volver al lobby, cerrar pestaña, etc.).
    return () => {
      // Se rearma la guarda: si React reusa esta instancia para una nueva
      // visita a la sala (volver desde el lobby sin recargar), el effect tiene
      // que poder unirse otra vez. Sin esto, la segunda entrada no llamaba a
      // join() y quedabas en la pantalla de llamada sin estar en la sala.
      startedRef.current = false;
      void hangup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  /**
   * Eliminar la sala. El server revalida que seas el dueño y que estés solo,
   * así que esto es la parte de UI de una decisión que se toma allá.
   */
  const handleDelete = async () => {
    setDeleting(true);
    try {
      const token = await getAccessTokenSilently();
      const res = await fetch(
        `${API_URL}/signaling/rooms/${encodeURIComponent(roomId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setDeleteError(body.message ?? 'Could not delete the room.');
        return;
      }
      // Colgar antes de navegar: cierra el SSE y suelta el micrófono.
      void hangup();
      navigate('/');
    } catch {
      setDeleteError('Could not reach the server.');
    } finally {
      setDeleting(false);
    }
  };

  const handleLeave = () => {
    // hangup también corre en el cleanup del effect, pero lo llamamos explícito
    // para colgar antes de cambiar de ruta.
    void hangup();
    navigate('/');
  };

  // Expulsar es irreversible para el otro (lo saca de la llamada sin aviso),
  // así que pedimos confirmación antes.
  const handleKick = () => {
    if (window.confirm('Remove the other participant from the room?')) {
      void kick();
    }
  };

  // Si NOS expulsaron, el hook ya cortó todo (mic, WebRTC, SSE); acá solo
  // sacamos al usuario de la pantalla de llamada y lo devolvemos al lobby.
  useEffect(() => {
    if (kicked) {
      navigate('/', { state: { kickedFrom: roomId } });
    }
  }, [kicked, navigate, roomId]);

  const live = status === 'connected';

  return (
    <Box
      sx={{
        minHeight: '100%',
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* --- Header --- */}
      <Stack
        component="header"
        direction="row"
        sx={{
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          px: { xs: 5, md: 12 },
          py: 6,
          gap: 4,
        }}
      >
        <IconButton
          onClick={handleLeave}
          aria-label="Back to lobby"
          sx={{ color: 'text.primary' }}
        >
          <ExpandMoreIcon sx={{ fontSize: 28 }} />
        </IconButton>

        <Stack sx={{ alignItems: 'center', gap: 2, minWidth: 0 }}>
          <Typography
            variant="h2"
            align="center"
            sx={{ wordBreak: 'break-all' }}
          >
            {roomId}
          </Typography>
          {isOwner && (
            <Chip
              size="small"
              icon={<WorkspacePremiumIcon />}
              label="You are the owner"
              sx={{
                bgcolor: support.warningContainer,
                color: support.warning,
                '& .MuiChip-icon': { color: support.warning },
              }}
            />
          )}
        </Stack>

        {/* En la maqueta este chip es un cronómetro; acá muestra el estado real
            de la llamada, que es el dato que la app sí tiene. */}
        <Chip
          label={STATUS_LABEL[status]}
          sx={{
            bgcolor: live ? 'rgba(143, 217, 196, 0.35)' : support.surfaceRaised,
            color: live ? brand.mintText : 'text.secondary',
            height: 40,
            px: 2,
          }}
        />
      </Stack>

      {error && (
        <Box sx={{ px: { xs: 5, md: 12 }, pb: 4 }}>
          <Alert
            severity="error"
            sx={{ bgcolor: support.errorContainer, color: 'error.main' }}
          >
            {error}
          </Alert>
        </Box>
      )}

      {/* --- Canvas: las dos tarjetas de participante --- */}
      <Stack
        component="main"
        direction={{ xs: 'column', md: 'row' }}
        sx={{
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          gap: { xs: 8, md: 16 },
          px: { xs: 5, md: 12 },
          py: 8,
          maxWidth: 1200,
          width: '100%',
          mx: 'auto',
        }}
      >
        {/* Tarjeta del PEER */}
        <Box
          sx={{
            width: '100%',
            maxWidth: 420,
            bgcolor: 'background.paper',
            borderRadius: '40px',
            border: '1px solid',
            borderColor: 'divider',
            p: 10,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            opacity: peerConnected ? 1 : 0.65,
          }}
        >
          <Box sx={{ position: 'relative', display: 'grid' }}>
            {/* Anillos animados: solo mientras hay audio del peer. */}
            {peerConnected &&
              [0, 1].map((i) => (
                <Box
                  key={i}
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    border: '3px solid',
                    borderColor: brand.mint,
                    animation: `${pulseRing} 2s cubic-bezier(0.215,0.61,0.355,1) infinite`,
                    animationDelay: `${i}s`,
                  }}
                />
              ))}
            <Avatar
              // Foto de Google del peer. Si todavía no se resolvió el perfil
              // (o el usuario no tiene foto), MUI cae al children: la inicial
              // de su nombre, y si tampoco hay nombre, el ícono genérico.
              src={peerProfile?.picture ?? undefined}
              alt={peerProfile?.name ?? 'Participant'}
              sx={{
                width: 192,
                height: 192,
                bgcolor: brand.mint,
                color: brand.mintText,
                border: '4px solid',
                borderColor: 'background.paper',
                fontSize: 72,
              }}
            >
              {peerProfile?.name?.[0]?.toUpperCase() ?? (
                <PersonIcon sx={{ fontSize: 90 }} />
              )}
            </Avatar>
            {peerConnected && (
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  bottom: 12,
                  right: 12,
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  bgcolor: brand.mintText,
                  border: '4px solid',
                  borderColor: 'background.paper',
                }}
              />
            )}
          </Box>

          <Stack sx={{ alignItems: 'center', gap: 4, width: '100%' }}>
            <Typography variant="h1">
              {/* Nombre real del peer. Mientras el perfil no llegó, se cae a
                  'Participant' para no dejar el título vacío un instante. */}
              {peerConnected
                ? (peerProfile?.name ?? 'Participant')
                : 'Nobody here yet'}
            </Typography>

            {peerConnected && peerMuted ? (
              // El peer silenció su micrófono. Se muestra en vez de la onda de
              // audio: dibujar actividad mientras el otro está en silencio haría
              // pensar que el problema es tuyo.
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                  bgcolor: support.surfaceRaised,
                  color: 'text.secondary',
                  borderRadius: 9999,
                  px: 4,
                  py: 2,
                  minWidth: 160,
                }}
              >
                <MicOffIcon sx={{ fontSize: 20 }} />
                <Typography variant="body2">Muted</Typography>
              </Stack>
            ) : peerConnected ? (
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  bgcolor: 'rgba(143, 217, 196, 0.4)',
                  color: brand.mintText,
                  borderRadius: 9999,
                  px: 4,
                  py: 2,
                  minWidth: 160,
                }}
              >
                <AudioWave color={brand.mintText} />
                <Typography variant="caption">Speaking</Typography>
              </Stack>
            ) : (
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  gap: 2,
                  bgcolor: support.surfaceRaised,
                  color: 'text.secondary',
                  borderRadius: 9999,
                  px: 4,
                  py: 2,
                }}
              >
                <HourglassEmptyIcon sx={{ fontSize: 18 }} />
                <Typography variant="caption">
                  Waiting for the other participant…
                </Typography>
              </Stack>
            )}
          </Stack>
        </Box>

        {/* Tarjeta PROPIA */}
        <Box
          sx={{
            width: '100%',
            maxWidth: 420,
            bgcolor: 'background.paper',
            borderRadius: '40px',
            border: '1px solid',
            borderColor: 'divider',
            p: 10,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {/* Mi propia foto, de Auth0. El nombre NO se muestra: abajo dice
              "You", que es más claro que leer el nombre de uno mismo. */}
          <Avatar
            src={user?.picture ?? undefined}
            alt="You"
            sx={{
              width: 160,
              height: 160,
              bgcolor: support.surfaceRaised,
              color: 'text.secondary',
              opacity: muted ? 0.7 : 1,
              fontSize: 60,
            }}
          >
            {user?.name?.[0]?.toUpperCase() ?? (
              <PersonIcon sx={{ fontSize: 74 }} />
            )}
          </Avatar>

          <Stack sx={{ alignItems: 'center', gap: 4, width: '100%' }}>
            <Typography variant="h2" color="text.primary">
              You
            </Typography>

            {muted ? (
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  gap: 2,
                  bgcolor: support.surfaceRaised,
                  color: 'text.secondary',
                  borderRadius: 9999,
                  px: 4,
                  py: 2,
                }}
              >
                <MicOffIcon sx={{ fontSize: 18 }} />
                <Typography variant="caption">Muted</Typography>
              </Stack>
            ) : (
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  bgcolor: 'rgba(143, 217, 196, 0.4)',
                  color: brand.mintText,
                  borderRadius: 9999,
                  px: 4,
                  py: 2,
                  minWidth: 160,
                }}
              >
                <AudioWave color={brand.mintText} />
                <Typography variant="caption">Microphone on</Typography>
              </Stack>
            )}
          </Stack>
        </Box>
      </Stack>

      {/* --- Barra de acciones --- */}
      <Stack
        direction="row"
        sx={{
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: 4,
          px: { xs: 5, md: 12 },
          pb: 10,
        }}
      >
        <Button
          variant="contained"
          startIcon={muted ? <MicOffIcon /> : <MicIcon />}
          onClick={toggleMute}
          disabled={status === 'idle' || status === 'room-full'}
          sx={{
            bgcolor: muted ? 'error.main' : brand.mint,
            color: muted ? brand.white : brand.mintText,
            '&:hover': { bgcolor: muted ? 'error.dark' : '#7CCBB4' },
          }}
        >
          {muted ? 'Unmute' : 'Mute'}
        </Button>

        {/* Expulsar: solo el DUEÑO de la room lo ve, y solo sirve si hay
            alguien del otro lado. Ocultarlo al invitado es cosmético — el
            server rechaza el kick de quien no es dueño. */}
        {isOwner && (
          <Button
            variant="contained"
            startIcon={<PersonRemoveIcon />}
            onClick={handleKick}
            disabled={!peerConnected}
            sx={{
              bgcolor: support.warning,
              color: brand.white,
              '&:hover': { bgcolor: '#B45309' },
            }}
          >
            Remove
          </Button>
        )}

        {/* Eliminar la sala. Solo el dueño la ve, y solo se habilita cuando
            está SOLO: borrarla con alguien adentro le cortaría la llamada de
            golpe. Para sacar a alguien ya está "Remove", que es otra acción.
            El server revalida ambas condiciones. */}
        {isOwner && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteOutlineIcon />}
            onClick={() => setConfirmDelete(true)}
            disabled={peerConnected}
            title={
              peerConnected
                ? 'You can only delete the room when nobody else is in it'
                : undefined
            }
          >
            Delete room
          </Button>
        )}

        <Button
          variant="outlined"
          color="secondary"
          startIcon={<CallEndIcon />}
          onClick={handleLeave}
        >
          Hang up and leave
        </Button>
      </Stack>

      <Typography
        variant="caption"
        align="center"
        color="text.secondary"
        sx={{ pb: 6, opacity: 0.7, wordBreak: 'break-all', px: 5 }}
      >
        clientId: {clientId}
      </Typography>

      {/* Audio remoto del peer. IMPRESCINDIBLE: es lo que reproduce la voz del
          otro lado; si este elemento no está montado, la llamada no se oye. */}
      {/* Confirmación de borrado: es irreversible, así que no se ejecuta de
          un solo clic. */}
      <Dialog
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
      >
        <DialogTitle>Delete this room?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The room <strong>{roomId}</strong> will be removed permanently and
            will disappear from the lobby. This cannot be undone.
          </DialogContentText>
          {deleteError && (
            <Alert severity="error" sx={{ mt: 4 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5, gap: 2 }}>
          <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete room'}
          </Button>
        </DialogActions>
      </Dialog>

      <audio ref={remoteAudioRef} autoPlay />
    </Box>
  );
}

export default Room;
