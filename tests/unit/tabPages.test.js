import { describe, expect, test } from '@jest/globals';
import { TAB_OPEN_PREFS, createPageInContext } from '../../lib/tab-pages.js';

class FakePage {
  constructor(context) { this.context = context; this.closed = false; }
  isClosed() { return this.closed; }
  async evaluate() { this.context.openFromExisting(); }
}

class FakeContext {
  constructor({ failWindowOpen = false } = {}) {
    this.pagesList = [];
    this.waiters = [];
    this.failWindowOpen = failWindowOpen;
  }
  pages() { return this.pagesList; }
  async newPage() {
    const page = new FakePage(this);
    this.pagesList.push(page);
    return page;
  }
  waitForEvent(event, { timeout } = {}) {
    if (event !== 'page') return Promise.reject(new Error(`unexpected event ${event}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('page event timeout')), timeout || 1000);
      this.waiters.push((page) => { clearTimeout(timer); resolve(page); });
    });
  }
  openFromExisting() {
    if (this.failWindowOpen) throw new Error('window.open blocked');
    const page = new FakePage(this);
    this.pagesList.push(page);
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
  }
}

describe('tab page creation', () => {
  test('prefs ask Firefox to open window.open targets as tabs', () => {
    expect(TAB_OPEN_PREFS['browser.link.open_newwindow']).toBe(3);
    expect(TAB_OPEN_PREFS['browser.link.open_newwindow.restriction']).toBe(0);
  });

  test('the first page uses newPage and later pages use window.open', async () => {
    const context = new FakeContext();
    const first = await createPageInContext(context, { reason: 'tab' });
    const second = await createPageInContext(context, { reason: 'tab' });
    const third = await createPageInContext(context, { reason: 'tab' });

    expect(first.openedVia).toBe('newPage');
    expect(second.openedVia).toBe('window.open');
    expect(third.openedVia).toBe('window.open');
    expect(context.pages()).toHaveLength(3);
  });

  test('falls back to newPage when window.open cannot open a page', async () => {
    const context = new FakeContext({ failWindowOpen: true });
    await createPageInContext(context);
    const fallback = await createPageInContext(context);
    expect(fallback.openedVia).toBe('newPage-fallback');
    expect(context.pages()).toHaveLength(2);
  });
});
