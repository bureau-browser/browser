import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('dedicated tab lifecycle', () => {
  test('a closed recording leaves dedicatedTabs and moves to the video grace map', () => {
    expect(serverSource).toContain('const finalizedVideos = new Map();');
    expect(serverSource).toContain('dedicatedTabs.delete(tabId);');
    expect(serverSource).toContain('if (dedicated.videoDir) finalizedVideos.set(tabId, dedicated);');
  });

  test('destroyTab tolerates a missing shared session', () => {
    expect(serverSource).toContain('if (!session || !session.tabGroups) return false;');
  });

  test('destroyTimedOutTab has a dedicated branch that does not use group.delete', () => {
    const fn = serverSource.slice(serverSource.indexOf('async function destroyTimedOutTab'));
    expect(fn).toContain('if (found.dedicated) {');
    expect(fn.indexOf('if (found.dedicated) {')).toBeLessThan(fn.indexOf('group.delete(tabId)'));
  });
});
