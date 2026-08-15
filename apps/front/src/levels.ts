/**
 * Niveles de inglés (MCER-ish), de Beginner a Upper. Hardcodeados: son un
 * catálogo fijo del producto, no data de servidor.
 * El `value` viaja dentro del roomId, así que se mantiene corto y slug-safe.
 *
 * Vive acá (y no en CreateRoomModal) porque lo comparten dos pantallas: el
 * modal para CREAR la room y el filtro del lobby para LISTARLAS.
 */
export const LEVELS = [
  { value: 'beginner', label: 'Beginner (A1)' },
  { value: 'elementary', label: 'Elementary (A2)' },
  { value: 'pre-intermediate', label: 'Pre-Intermediate (A2+)' },
  { value: 'intermediate', label: 'Intermediate (B1)' },
  { value: 'upper-intermediate', label: 'Upper-Intermediate (B2)' },
  { value: 'upper', label: 'Upper / Advanced (C1)' },
] as const;

export type LevelValue = (typeof LEVELS)[number]['value'];

/**
 * Extrae el nivel de un roomId con forma `{nivel}-{tópico}-{sufijo}`.
 *
 * OJO con `startsWith` a secas: varios values comparten prefijo entre sí
 * ("upper" es prefijo de "upper-intermediate", "intermediate" de nada pero
 * "pre-intermediate" lo contiene). Por eso se exige que después del value
 * venga un guion, y se prueba del más largo al más corto para que
 * "upper-intermediate-travel-a1b2" no matchee como "upper".
 *
 * Devuelve null si el roomId no arranca con un nivel conocido (rooms creadas
 * a mano por URL, que son válidas y deben poder listarse igual).
 */
const BY_LENGTH = [...LEVELS].sort((a, b) => b.value.length - a.value.length);

export function levelFromRoomId(roomId: string): LevelValue | null {
  const id = roomId.toLowerCase();
  return BY_LENGTH.find((l) => id.startsWith(`${l.value}-`))?.value ?? null;
}
