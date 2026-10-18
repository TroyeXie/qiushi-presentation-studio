/** Service character budget, independent of any model's advertised token context. */
export const DEFAULT_INPUT_CHARS = 400_000;
export const MIN_INPUT_CHARS = 80_000;
export const MAX_INPUT_CHARS = 1_000_000;

export function resolveInputChars(value?: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_INPUT_CHARS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INPUT_CHARS;
  return Math.min(MAX_INPUT_CHARS, Math.max(MIN_INPUT_CHARS, Math.floor(parsed)));
}
