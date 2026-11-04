import { describe, expect, test } from '@jest/globals';
import { resolveTypeMode } from '../../lib/type-mode.js';

describe('resolveTypeMode', () => {
  test('keyboard mode with delay and no selector stays keyboard (no human click/clear)', () => {
    expect(resolveTypeMode({ mode: 'keyboard', delay: 90 })).toEqual({ mode: 'keyboard', useHuman: false });
  });

  test('keyboard mode with delay and a selector stays keyboard', () => {
    expect(resolveTypeMode({ mode: 'keyboard', delay: 90 })).toEqual({ mode: 'keyboard', useHuman: false });
  });

  test('fill mode with delay still uses human typing', () => {
    expect(resolveTypeMode({ mode: 'fill', delay: 90 })).toEqual({ mode: 'fill', useHuman: true });
  });

  test('the explicit human flag and mode human always win', () => {
    expect(resolveTypeMode({ mode: 'keyboard', human: true })).toEqual({ mode: 'keyboard', useHuman: true });
    expect(resolveTypeMode({ mode: 'human' })).toEqual({ mode: 'human', useHuman: true });
  });

  test('rejects an unknown mode', () => {
    expect(() => resolveTypeMode({ mode: 'paste' })).toThrow("mode must be 'fill', 'keyboard' or 'human'");
  });
});
