import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('human typing budget and cancellation', () => {
  test('scales the tab-lock budget with the text length', () => {
    expect(serverSource).toContain('const typeBudgetMs = Math.max(');
    expect(serverSource).toContain('String(text).length * (baseDelay + 90 + 120) + 5000');
    expect(serverSource).toContain('}, typeBudgetMs).catch((err) => {');
  });

  test('cancels the keystroke loop when the route timeout fires', () => {
    expect(serverSource).toContain('const typeCancelled = { value: false };');
    expect(serverSource).toContain('if (typeCancelled.value) break;');
    expect(serverSource).toContain('typeCancelled.value = true;');
  });

  test('a queued tab operation waits as long as the op ahead of it', () => {
    expect(serverSource).toContain('await lock.acquire(Math.max(TAB_LOCK_TIMEOUT_MS, timeoutMs));');
  });
});
