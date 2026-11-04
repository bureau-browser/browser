import fs from 'fs';
import os from 'os';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(base, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`server did not become healthy at ${base}`);
}

describe('navigate queued behind a long fill', () => {
  let serverProcess;
  let tmpDir;
  let base;

  beforeAll(async () => {
    const env = getSharedEnv();
    const cfg = loadConfig();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-navqueue-'));
    const port = 4100 + Math.floor(Math.random() * 700);
    base = `http://127.0.0.1:${port}`;
    serverProcess = launchServer({
      pluginDir: path.resolve(__dirname, '../..'),
      port,
      env: {
        ...cfg.serverEnv,
        CAMOFOX_PROFILE_DIR: path.join(tmpDir, 'profile'),
        CAMOUFOX_INSTALL_DIR: process.env.CAMOUFOX_INSTALL_DIR,
        CAMOFOX_CRASH_REPORT_ENABLED: 'false',
        DEBUG_RESPONSES: 'false',
        HANDLER_TIMEOUT_MS: '2000',
        NAVIGATE_TIMEOUT_MS: '1000',
      },
      log: { info: () => {}, error: () => {} },
    });
    await waitForHealth(base);
    // Keep the shared test site URL alive for the test body.
    globalThis.__NAV_QUEUE_SITE__ = env.testSiteUrl;
  });

  afterAll(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
      const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
      serverProcess.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a navigate whose outer deadline expires while queued never runs afterwards', async () => {
    const client = createClient(base);
    const site = globalThis.__NAV_QUEUE_SITE__;
    try {
      const { tabId } = await client.createTab(`${site}/typing`);

      // Hold the tab lock with a human-paced fill long enough (about 15 s)
      // that the navigate deadline (6 s) expires while it is queued.
      const fillPromise = client.type(tabId, {
        selector: '#input',
        text: 'x'.repeat(60),
        human: true,
        delay: 90,
      });

      await sleep(300);
      const navigatePromise = client.navigate(tabId, `${site}/pageA`).then(
        (r) => ({ ok: true, r }),
        (e) => ({ ok: false, e: String(e) }),
      );
      const navigateOutcome = await navigatePromise;
      expect(navigateOutcome.ok).toBe(false);

      const fillResult = await fillPromise;
      expect(fillResult.ok).toBe(true);

      // Give a late queued navigate every chance to run before asserting.
      await sleep(1500);
      const state = await client.evaluate(tabId, 'JSON.stringify({ url: location.href, value: document.querySelector("#input").value })');
      const parsed = JSON.parse(state.result);
      expect(parsed.url).toContain('/typing');
      expect(parsed.value).toBe('x'.repeat(60));
    } finally {
      await client.cleanup();
    }
  }, 60000);
});
