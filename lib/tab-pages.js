/**
 * Open a page as a TAB of an existing Firefox window.
 *
 * Juggler's Browser.newPage always calls Services.ww.openWindow, so every
 * context.newPage() is a new top-level window. A page script calling
 * window.open() goes through Firefox's own tab policy instead. With
 * browser.link.open_newwindow=3 (new tab) and restriction=0 (apply to all
 * window.open calls), that page becomes a tab in the existing window and
 * Playwright still emits it as a `page` event on the context.
 *
 * The first page in a context must still use newPage() (there is no window to
 * attach to yet). Every later page uses window.open + waitForEvent('page').
 */

import { tracePageCreated } from './window-trace.js';

// Popup events caused by our own window.open must not be registered a second
// time by the server's target=_blank popup handler.
const expectedPopups = new WeakMap();

export function consumeExpectedPopup(openerPage) {
  const pending = expectedPopups.get(openerPage) || 0;
  if (pending <= 0) return false;
  if (pending === 1) expectedPopups.delete(openerPage);
  else expectedPopups.set(openerPage, pending - 1);
  return true;
}

export const TAB_OPEN_PREFS = {
  'browser.link.open_newwindow': 3,
  'browser.link.open_newwindow.restriction': 0,
};

export async function createPageInContext(context, {
  reason = 'tab',
  log = () => {},
  timeoutMs = 10000,
} = {}) {
  const canTab = typeof context.pages === 'function'
    && typeof context.waitForEvent === 'function';
  const existing = canTab ? context.pages().find((page) => !page.isClosed?.()) : null;
  if (!existing || typeof existing.evaluate !== 'function') {
    const page = await context.newPage();
    tracePageCreated(page, context, reason, { openedVia: 'newPage' });
    return { page, openedVia: 'newPage' };
  }

  try {
    expectedPopups.set(existing, (expectedPopups.get(existing) || 0) + 1);
    const pagePromise = context.waitForEvent('page', { timeout: timeoutMs });
    await existing.evaluate(() => { window.open('about:blank'); });
    const page = await pagePromise;
    tracePageCreated(page, context, reason, { openedVia: 'window.open' });
    return { page, openedVia: 'window.open' };
  } catch (err) {
    expectedPopups.delete(existing);
    log('warn', 'window.open tab creation failed, falling back to newPage', {
      reason,
      error: err.message,
    });
    const page = await context.newPage();
    tracePageCreated(page, context, reason, { openedVia: 'newPage-fallback' });
    return { page, openedVia: 'newPage-fallback' };
  }
}
