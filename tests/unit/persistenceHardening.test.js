import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getUserPersistencePaths,
  legacyStorageStatePath,
  loadPersistedStorageState,
  persistStorageState,
  readStorageStateFile,
} from '../../lib/persistence.js';

const logger = { warn: () => {} };

function cookie(name, domain, extra = {}) {
  return {
    name,
    value: 'redacted',
    domain,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
    ...extra,
  };
}

function fakeContext({ storageCookies = [], liveCookies = [] } = {}) {
  return {
    storageState: async () => ({ cookies: storageCookies, origins: [] }),
    cookies: async () => liveCookies,
  };
}

describe('persistence hardening', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persist-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('reads a legacy flat <userId>.json profile', async () => {
    await fs.writeFile(
      legacyStorageStatePath(dir, 'main'),
      JSON.stringify({ cookies: [cookie('a', '.example.com')], origins: [] })
    );
    const found = await loadPersistedStorageState(dir, 'main', logger);
    expect(found).toBe(legacyStorageStatePath(dir, 'main'));
  });

  test('persists the live httpOnly jar, not just storageState', async () => {
    const liAt = cookie('li_at', '.linkedin.com', { httpOnly: true });
    const ctx = fakeContext({ liveCookies: [liAt] });

    const result = await persistStorageState({ profileDir: dir, userId: 'main', context: ctx, logger });
    expect(result.persisted).toBe(true);
    expect(result.authed).toContain('linkedin');

    const saved = JSON.parse(await fs.readFile(getUserPersistencePaths(dir, 'main').storageStatePath, 'utf8'));
    expect(saved.cookies.map((c) => c.name)).toContain('li_at');
  });

  test('refuses to overwrite an authed jar with a logged-out one', async () => {
    const liAt = cookie('li_at', '.linkedin.com', { httpOnly: true });
    const first = await persistStorageState({
      profileDir: dir,
      userId: 'main',
      context: fakeContext({ liveCookies: [liAt] }),
      logger,
    });
    expect(first.persisted).toBe(true);

    const second = await persistStorageState({
      profileDir: dir,
      userId: 'main',
      context: fakeContext({ liveCookies: [cookie('JSESSIONID', '.linkedin.com')] }),
      logger,
    });
    expect(second.persisted).toBe(false);
    expect(second.reason).toBe('auth-downgrade');

    const saved = await readStorageStateFile(getUserPersistencePaths(dir, 'main').storageStatePath, logger);
    expect(saved.cookies.map((c) => c.name)).toContain('li_at');
  });

  test('caps non-auth cookies but keeps auth cookies verbatim', async () => {
    const liAt = cookie('li_at', '.linkedin.com', { httpOnly: true });
    const noise = Array.from({ length: 300 }, (_, i) => cookie(`noise_${i}`, '.example.com'));
    const result = await persistStorageState({
      profileDir: dir,
      userId: 'main',
      context: fakeContext({ liveCookies: [liAt, ...noise] }),
      logger,
    });
    expect(result.persisted).toBe(true);
    const saved = await readStorageStateFile(getUserPersistencePaths(dir, 'main').storageStatePath, logger);
    expect(saved.cookies.length).toBeLessThanOrEqual(120);
    expect(saved.cookies.map((c) => c.name)).toContain('li_at');
  });
});
