export const LEVELS = [
  { value: 'beginner', label: 'Beginner (A1)' },
  { value: 'elementary', label: 'Elementary (A2)' },
  { value: 'pre-intermediate', label: 'Pre-Intermediate (A2+)' },
  { value: 'intermediate', label: 'Intermediate (B1)' },
  { value: 'upper-intermediate', label: 'Upper-Intermediate (B2)' },
  { value: 'upper', label: 'Upper / Advanced (C1)' },
] as const;

export type LevelValue = (typeof LEVELS)[number]['value'];

const BY_LENGTH = [...LEVELS].sort((a, b) => b.value.length - a.value.length);

export function levelFromRoomId(roomId: string): LevelValue | null {
  const id = roomId.toLowerCase();
  return BY_LENGTH.find((l) => id.startsWith(`${l.value}-`))?.value ?? null;
}
