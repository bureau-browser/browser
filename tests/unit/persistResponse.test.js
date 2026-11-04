import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('/persist response contract', () => {
  test('keeps the fields Bureau reads alongside the new ones', () => {
    const route = serverSource.slice(
      serverSource.indexOf("app.post('/sessions/:userId/persist'"),
      serverSource.indexOf("app.get('/health'", serverSource.indexOf("app.post('/sessions/:userId/persist'")),
    );
    for (const field of ['userId: String(key)', 'cookieCount: names.length', 'cookieNames:', 'skipped:', 'written: result.persisted']) {
      expect(route).toContain(field);
    }
  });
});
