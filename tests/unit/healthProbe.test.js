import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('active health probe', () => {
  test('bounds the probe context creation', () => {
    expect(serverSource).toContain("withTimeout(browser.newContext({ viewport: null }), 5000, 'health probe newContext')");
  });

  test('does not open a probe page in headful mode', () => {
    const probe = serverSource.slice(serverSource.indexOf('// Active health probe'));
    expect(probe).toContain('if (!CONFIG.headful) {');
    const branch = probe.indexOf('if (!CONFIG.headful) {');
    const newPage = probe.indexOf('testContext.newPage()');
    expect(newPage).toBeGreaterThan(branch);
  });
});
