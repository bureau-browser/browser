import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('C3 tabs and contexts', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  async function json(method, path, body) {
    const res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
  }

  test('GET /tabs without userId is a 400', async () => {
    const { status, body } = await json('GET', '/tabs');
    expect(status).toBe(400);
    expect(body.error).toContain('userId');
  });

  test('two concurrent cold POST /tabs for one user share one context and one window', async () => {
    const client = createClient(serverUrl);
    try {
      const before = await client.health();
      const [a, b] = await Promise.all([
        client.createTab(`${testSiteUrl}/pageA`),
        client.createTab(`${testSiteUrl}/pageB`),
      ]);
      expect(a.tabId).not.toBe(b.tabId);

      const { body } = await json('GET', `/tabs?userId=${encodeURIComponent(client.userId)}`);
      const mine = body.tabs.filter((tab) => tab.tabId === a.tabId || tab.tabId === b.tabId);
      expect(mine).toHaveLength(2);
      expect(mine[0].contextId).toBeTruthy();
      expect(mine[0].contextId).toBe(mine[1].contextId);

      const after = await client.health();
      expect(after.windows - before.windows).toBe(1);
      expect(after.activeTabs - before.activeTabs).toBe(2);
    } finally {
      await client.cleanup();
    }
  });

  test('the anchor page is not counted as a tab', async () => {
    const client = createClient(serverUrl);
    try {
      const before = await client.health();
      await client.createTab(`${testSiteUrl}/pageA`);
      const after = await client.health();
      expect(after.activeTabs - before.activeTabs).toBe(1);
    } finally {
      await client.cleanup();
    }
  });

  test('a dedicated viewport tab is listed, works, and its context closes on DELETE', async () => {
    const client = createClient(serverUrl);
    try {
      const created = await json('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'dedicated-test',
        viewport: { width: 400, height: 300 },
        url: `${testSiteUrl}/pageA`,
      });
      expect(created.status).toBe(200);
      const tabId = created.body.tabId;

      const listed = await json('GET', `/tabs?userId=${encodeURIComponent(client.userId)}`);
      expect(listed.body.tabs.some((tab) => tab.tabId === tabId)).toBe(true);

      const evaluated = await json('POST', `/tabs/${tabId}/evaluate`, {
        userId: client.userId,
        expression: 'JSON.stringify({w: innerWidth, h: innerHeight})',
      });
      expect(JSON.parse(evaluated.body.result)).toEqual({ w: 400, h: 300 });

      const healthWithDedicated = await client.health();
      const deleted = await json('DELETE', `/tabs/${tabId}?userId=${encodeURIComponent(client.userId)}`);
      expect(deleted.status).toBe(200);
      const after = await json('GET', `/tabs?userId=${encodeURIComponent(client.userId)}`);
      expect(after.body.tabs.some((tab) => tab.tabId === tabId)).toBe(false);
      expect((await client.health()).windows).toBe(healthWithDedicated.windows - 1);
    } finally {
      await client.cleanup();
    }
  });

  test('a popup login flow posts back to the opener and closes as a tab', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/popup-login-parent`);
      await client.click(tabId, { selector: '#open' });
      let result = '';
      for (let i = 0; i < 30; i++) {
        const evaluated = await client.evaluate(tabId, 'document.getElementById("result").textContent');
        result = evaluated.result;
        if (result.startsWith('received:')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(result).toBe('received:hello');
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot meta and headers report the real pixel dimensions', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const res = await fetch(`${serverUrl}/tabs/${tabId}/screenshot?userId=${encodeURIComponent(client.userId)}&meta=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-screenshot-width')).toMatch(/^\d+$/);
      expect(res.headers.get('x-screenshot-height')).toMatch(/^\d+$/);
      const body = await res.json();
      expect(body.width).toBeGreaterThan(0);
      expect(body.height).toBeGreaterThan(0);
      expect(body.screenshot.width).toBe(body.width);
      expect(body.screenshot.height).toBe(body.height);
      expect(body.screenshot.mimeType).toBe('image/png');
    } finally {
      await client.cleanup();
    }
  });
});
