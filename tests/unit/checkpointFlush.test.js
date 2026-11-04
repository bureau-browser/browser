import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('debounced session checkpoint', () => {
  test('defines a per-user debounced flush', () => {
    expect(serverSource).toContain('function scheduleFlush(userId, delayMs = 2000)');
    expect(serverSource).toContain('const flushTimers = new Map();');
    expect(serverSource).toContain('persistStorageState({');
  });

  test('schedules a flush after a successful tab operation and a successful user op', () => {
    expect(serverSource).toContain('const owner = userIdForTab(tabId);');
    expect(serverSource).toContain('if (owner) scheduleFlush(owner);');
    expect(serverSource).toContain('if (sessions.has(key)) scheduleFlush(key);');
  });
});
