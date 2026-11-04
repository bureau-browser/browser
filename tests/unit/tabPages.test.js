import { describe, expect, test } from '@jest/globals';
import { TAB_OPEN_PREFS, createPageInContext, isAnchorPage } from '../../lib/tab-pages.js';

class FakePage {
  constructor(context, { name = '', failOpen = false } = {}) {
    this.context = context;
    this.name = name;
    this.failOpen = failOpen;
    this.waiters = [];
  }

  isClosed() { return false; }

  async evaluate(fn, arg) {
    if (typeof arg === 'string') {
      if (this.failOpen) throw new Error('window.open threw');
      // Yield first so concurrent callers both have a waiter registered before
      // the page event, like a real browser round-trip.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const page = new FakePage(this.context, { name: arg });
      this.context.pagesList.push(page);
      // Playwright semantics: every pending popup waiter on this opener
      // resolves with the same first page event.
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) waiter.resolve(page);
      return null;
    }
    if (String(fn).includes('window.name')) return this.name;
    return null;
  }

  waitForEvent(event, { timeout } = {}) {
    if (event !== 'popup') return Promise.reject(new Error(`unexpected event ${event}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('popup timeout')), timeout || 1000);
      this.waiters.push({ resolve: (page) => { clearTimeout(timer); resolve(page); }, reject });
    });
  }
}

class FakeContext {
  constructor({ failOpen = false } = {}) {
    this.pagesList = [];
    this.failOpen = failOpen;
  }
  pages() { return this.pagesList; }
  async newPage() {
    const page = new FakePage(this, { failOpen: this.failOpen });
    this.pagesList.push(page);
    return page;
  }
  waitForEvent() { return Promise.reject(new Error('use page.waitForEvent')); }
}

describe('tab page creation', () => {
  test('prefs ask Firefox to open window.open targets as tabs', () => {
    expect(TAB_OPEN_PREFS['browser.link.open_newwindow']).toBe(3);
    expect(TAB_OPEN_PREFS['browser.link.open_newwindow.restriction']).toBe(0);
  });

  test('the anchor is never returned and every user page opens from it', async () => {
    const context = new FakeContext();
    const first = await createPageInContext(context, { reason: 'tab' });
    const second = await createPageInContext(context, { reason: 'tab' });

    expect(first.openedVia).toBe('window.open');
    expect(second.openedVia).toBe('window.open');
    expect(second.page).not.toBe(first.page);
    const anchors = context.pages().filter((page) => isAnchorPage(page));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).not.toBe(first.page);
    expect(anchors[0].name).toBe('');
    expect(first.page.name).toMatch(/^camofox-tab-/);
    expect(second.page.name).toMatch(/^camofox-tab-/);
  });

  test('concurrent creations get distinct pages even when every waiter would see the first popup', async () => {
    const context = new FakeContext();
    const [a, b] = await Promise.all([
      createPageInContext(context, { reason: 'tab' }),
      createPageInContext(context, { reason: 'tab' }),
    ]);

    expect(a.page).not.toBe(b.page);
    expect(a.openedVia).toBe('window.open');
    expect(b.openedVia).toBe('window.open');
    expect(a.page.name).toMatch(/^camofox-tab-/);
    expect(b.page.name).toMatch(/^camofox-tab-/);
    expect(a.page.name).not.toBe(b.page.name);
    expect(context.pages().filter((page) => isAnchorPage(page))).toHaveLength(1);
  });

  test('falls back to newPage when window.open cannot open a page', async () => {
    const context = new FakeContext({ failOpen: true });
    const first = await createPageInContext(context, { timeoutMs: 300 });
    expect(first.openedVia).toBe('newPage-fallback');
    const second = await createPageInContext(context, { timeoutMs: 300 });
    expect(second.openedVia).toBe('newPage-fallback');
    expect(context.pages().filter((page) => isAnchorPage(page))).toHaveLength(1);
  });
});
