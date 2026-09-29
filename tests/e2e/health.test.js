import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const BROWSER_STATES = ['launching', 'running', 'idle', 'crash-looping'];

async function json(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

describe('Health contract and keepAlive over HTTP', () => {
  let serverUrl;

  beforeAll(async () => {
    await startServer();
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('/health keeps every legacy field and adds the lifecycle fields', async () => {
    const client = createClient(serverUrl);
    const h = await client.health();

    for (const k of ['ok', 'engine', 'browserConnected', 'browserRunning', 'activeTabs', 'activeSessions', 'consecutiveFailures']) {
      expect(h).toHaveProperty(k);
    }
    expect(h.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(h.startedAt))).toBe(false);
    expect(BROWSER_STATES).toContain(h.browserState);
    expect(h).toHaveProperty('launchedAt');
    expect(h).toHaveProperty('lastLaunchMs');
    expect(h).toHaveProperty('lastRestartReason');
    expect(h.launchBudgetMs).toBe(120000);
    expect(h.crashLoopThreshold).toBe(3);
  });

  test('bootId is stable within a process; browserState is running once a tab exists', async () => {
    const client = createClient(serverUrl);
    const before = await client.health();
    try {
      await client.createTab();
      const after = await client.health();
      expect(after.bootId).toBe(before.bootId);
      expect(after.browserState).toBe('running');
      expect(after.launchedAt).not.toBeNull();
      expect(typeof after.lastLaunchMs).toBe('number');
      expect(after.activeSessions).toBeGreaterThanOrEqual(1);
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('keepAlive is set on POST /tabs and shown in /tabs and /sessions', async () => {
    const client = createClient(serverUrl);
    try {
      const created = await client.request('POST', '/tabs', { userId: client.userId, sessionKey: client.sessionKey, keepAlive: true });
      client.tabs.push(created.tabId);
      expect(created.keepAlive).toBe(true);

      const list = await client.request('GET', `/tabs?userId=${client.userId}`);
      expect(list.keepAlive).toBe(true);
      expect(list.tabs[0].keepAlive).toBe(true);

      const { body } = await json(`${serverUrl}/sessions`);
      const mine = body.sessions.find((s) => s.userId === client.userId);
      expect(mine).toMatchObject({ keepAlive: true, tabs: 1 });

      const health = await client.health();
      expect(health.keepAliveSessions).toBeGreaterThanOrEqual(1);

      const off = await client.request('POST', '/tabs', { userId: client.userId, sessionKey: client.sessionKey, keepAlive: false });
      client.tabs.push(off.tabId);
      expect(off.keepAlive).toBe(false);
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('a session without keepAlive reports false', async () => {
    const client = createClient(serverUrl);
    try {
      const created = await client.createTab();
      expect(created.keepAlive).toBe(false);
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('POST /start is idempotent and leaves the browser running', async () => {
    const { status, body } = await json(`${serverUrl}/start`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const h = await createClient(serverUrl).health();
    expect(h.browserState).toBe('running');
  }, 120000);
});

describe('bootId across a real process restart', () => {
  test('a new server process reports a different bootId', async () => {
    await startServer();
    const first = await createClient(getServerUrl()).health();
    await stopServer();

    await startServer();
    const second = await createClient(getServerUrl()).health();
    await stopServer();

    expect(first.bootId).not.toBe(second.bootId);
    expect(Date.parse(second.startedAt)).toBeGreaterThanOrEqual(Date.parse(first.startedAt));
  }, 180000);
});
