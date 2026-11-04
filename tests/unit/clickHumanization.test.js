import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('click humanisation and duplicate tolerance', () => {
  test('falls back to .first() when the visible-match does not resolve', () => {
    expect(serverSource).toContain('if (!isLocator && !constrained) {');
    expect(serverSource).toContain('locator = tabState.page.locator(locatorOrSelector).first();');
  });

  test('moves in steps and holds the button like a person', () => {
    expect(serverSource).toContain('mouse.move(x, y, { steps: 4 })');
    expect(serverSource).toContain('waitForTimeout(70 + Math.floor(Math.random() * 120))');
    expect(serverSource).toContain('waitForTimeout(60 + Math.floor(Math.random() * 90))');
  });
});
