/**
 * Decide how a /type request is executed.
 *
 * `mode: 'fill'` is the default fast value-set. `human` (explicit flag or
 * mode 'human') always takes the human-paced branch. A bare `delay` only
 * implies human typing in fill mode; keyboard mode keeps its upstream
 * behaviour (char-by-char into the focused/selected field).
 */
export function resolveTypeMode({ mode = 'fill', human = false, delay } = {}) {
  if (mode !== 'fill' && mode !== 'keyboard' && mode !== 'human') {
    throw new Error("mode must be 'fill', 'keyboard' or 'human'");
  }
  const useHuman = human || mode === 'human' || (mode === 'fill' && delay != null);
  return { mode, useHuman };
}
