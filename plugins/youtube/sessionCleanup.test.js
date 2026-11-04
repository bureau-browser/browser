import { describe, expect, test } from '@jest/globals';
import { createPageInContext, userPages } from '../../lib/tab-pages.js';
import { shouldCloseTranscriptSession } from './index.js';

class FakePage {
  constructor(context, name = '') { this.context = context; this.name = name; this.closed = false; }
  isClosed() { return this.closed; }
  async evaluate(fn, arg) {
    if (typeof arg === 'string') {
      const page = new FakePage(this.context, arg);
      this.context.pagesList.push(page);
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) waiter(page);
      return null;
    }
    if (String(fn).includes('window.name')) return this.name;
    return null;
  }
  waitForEvent(event, { timeout } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('popup timeout')), timeout || 1000);
      this.waiters.push((page) => { clearTimeout(timer); resolve(page); });
    });
  }
}

class FakeContext {
  constructor() { this.pagesList = []; }
  pages() { return this.pagesList; }
  async newPage() { const page = new FakePage(this); this.pagesList.push(page); return page; }
  waitForEvent() { return Promise.reject(new Error('unused')); }
}

describe('YouTube transcript session cleanup', () => {
  test('an anchor-only context is closed, a context with a user page is kept', async () => {
    const context = new FakeContext();
    const { page } = await createPageInContext(context, { timeoutMs: 1000 });
    const session = { context, pageLeases: new Set() };

    const users = userPages(context);
    expect(users.length).toBeGreaterThan(0);
    expect(shouldCloseTranscriptSession(session)).toBe(false);

    for (const userPage of users) userPage.closed = true;
    expect(userPages(context)).toHaveLength(0);
    expect(shouldCloseTranscriptSession(session)).toBe(true);
  });
});
