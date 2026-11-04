import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { jarGainedAuth } from '../../lib/persistence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

function cookie(name, domain) {
  return { name, domain, path: '/', value: 'redacted', expires: -1 };
}

describe('cross-instance login pickup', () => {
  test('detects a platform gained on disk but absent from the live context', () => {
    expect(jarGainedAuth(new Set(), [cookie('li_at', '.linkedin.com')])).toEqual(['linkedin']);
    expect(jarGainedAuth(new Set(['linkedin']), [cookie('li_at', '.linkedin.com')])).toEqual([]);
  });

  test('getSession refreshes a live context when the jar mtime changes', () => {
    expect(serverSource).toContain('function persistedJarPath(userId)');
    expect(serverSource).toContain('if (mtime !== session.jarMtime)');
    expect(serverSource).toContain('const gained = jarGainedAuth(session.authed, saved?.cookies || []);');
    expect(serverSource).toContain("reason: 'jar_auth_gained'");
  });
});
