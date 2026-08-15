import { useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { LEVELS } from './levels';
import { brand } from './theme';

/**
 * Tópicos de conversación, también hardcodeados.
 * "Anything goes" va primero a propósito: es el default del select, la opción
 * de menor fricción para quien solo quiere hablar y no elegir un tema.
 */
const TOPICS = [
  { value: 'free-talk', label: 'Anything goes (free talk)' },
  { value: 'daily-life', label: 'Daily life & routines' },
  { value: 'travel', label: 'Travel & holidays' },
  { value: 'food', label: 'Food & cooking' },
  { value: 'movies-series', label: 'Movies & series' },
  { value: 'music', label: 'Music' },
  { value: 'sports', label: 'Sports & fitness' },
  { value: 'work', label: 'Work & careers' },
  { value: 'job-interview', label: 'Job interviews' },
  { value: 'technology', label: 'Technology & AI' },
  { value: 'business', label: 'Business & startups' },
  { value: 'education', label: 'Education & studying' },
  { value: 'health', label: 'Health & wellbeing' },
  { value: 'family-friends', label: 'Family & friends' },
  { value: 'hobbies', label: 'Hobbies & free time' },
  { value: 'books', label: 'Books & reading' },
  { value: 'news', label: 'News & current events' },
  { value: 'culture', label: 'Culture & traditions' },
  { value: 'environment', label: 'Environment & climate' },
  { value: 'shopping', label: 'Shopping & money' },
  { value: 'city-life', label: 'City life & transport' },
  { value: 'pets', label: 'Pets & animals' },
  { value: 'videogames', label: 'Video games' },
  { value: 'science', label: 'Science & space' },
  { value: 'social-media', label: 'Social media' },
  { value: 'small-talk', label: 'Small talk & icebreakers' },
] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Recibe el roomId ya resuelto a partir de nivel + tópico. */
  onCreate: (roomId: string) => void;
}

/**
 * Modal de alta de room de TalkToMe.
 *
 * No hay input de nombre libre: la room se identifica por el par
 * (nivel de inglés, tópico), que es justo lo que alguien busca al unirse.
 * Se le agrega un sufijo corto aleatorio para que dos personas puedan crear
 * rooms distintas con la misma combinación sin chocar (la room es 1-a-1).
 *
 * El backdrop es Petrol Blue sólido al 40% SIN blur: el sistema de diseño no
 * usa desenfoque ni sombras, la profundidad se expresa por capas tonales.
 */
function CreateRoomModal({ open, onClose, onCreate }: Props) {
  const [level, setLevel] = useState<string>(LEVELS[0].value);
  const [topic, setTopic] = useState<string>(TOPICS[0].value);

  const submit = () => {
    onCreate(`${level}-${topic}-${crypto.randomUUID().slice(0, 4)}`);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      slotProps={{
        paper: {
          sx: {
            borderRadius: '20px',
            bgcolor: brand.cream,
            p: { xs: 6, sm: 10 },
            border: '1px solid',
            borderColor: 'divider',
          },
        },
        backdrop: {
          sx: { bgcolor: 'rgba(28, 58, 69, 0.4)', backdropFilter: 'none' },
        },
      }}
    >
      <IconButton
        onClick={onClose}
        aria-label="Close"
        sx={{ position: 'absolute', top: 12, right: 12, color: 'text.primary' }}
      >
        <CloseIcon />
      </IconButton>

      <Stack spacing={6}>
        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="h2">Create room</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Pick your level and what you want to talk about.
          </Typography>
        </Box>

        <TextField
          select
          fullWidth
          label="English level"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          {LEVELS.map((l) => (
            <MenuItem key={l.value} value={l.value}>
              {l.label}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          fullWidth
          label="Topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          // La lista es larga: se le pone tope de alto al menú para que no
          // desborde la pantalla y scrollee dentro del popup.
          slotProps={{
            select: {
              MenuProps: { slotProps: { paper: { sx: { maxHeight: 320 } } } },
            },
          }}
        >
          {TOPICS.map((t) => (
            <MenuItem key={t.value} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>

        <Button
          fullWidth
          variant="contained"
          startIcon={<AddIcon />}
          onClick={submit}
        >
          Create
        </Button>

        <Stack
          direction="row"
          spacing={2}
          sx={{
            justifyContent: 'center',
            alignItems: 'center',
            color: 'text.secondary',
          }}
        >
          <InfoOutlinedIcon sx={{ fontSize: 16 }} />
          <Typography variant="caption">
            Each room holds up to 2 participants.
          </Typography>
        </Stack>
      </Stack>
    </Dialog>
  );
}

export default CreateRoomModal;
