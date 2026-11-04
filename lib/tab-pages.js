/**
 * Open a page as a TAB of an existing Firefox window.
 *
 * Juggler's Browser.newPage always calls Services.ww.openWindow, so every
 * context.newPage() is a new top-level window. A page script calling
 * window.open() goes through Firefox's own tab policy instead. With
 * browser.link.open_newwindow=3 (new tab) and restriction=0 (apply to all
 * window.open calls), that page becomes a tab in the existing window and
 * Playwright still emits it as a popup/page on the context.
 *
 * The first page in a context must still use newPage() (there is no window to
 * attach to yet). Later pages are opened from an about:blank anchor tab we own:
 * the site's own page never calls window.open, is never navigated, and the new
 * tab is created with noopener plus a unique name so we can match exactly the
 * page we asked for. Creation is serialised per context because Playwright
 * resolves every pending waitForEvent('page') with the same first page event.
 */

import { randomUUID } from 'crypto';
import { tracePageCreated } from './window-trace.js';

export const TAB_OPEN_PREFS = {
  'browser.link.open_newwindow': 3,
  'browser.link.open_newwindow.restriction': 0,
};

const anchors = new WeakMap();
const anchorPages = new WeakSet();
const creationQueues = new WeakMap();
const pendingNames = new Set();

export function isAnchorPage(page) {
  return anchorPages.has(page);
}

/**
 * The server's popup handler calls this with the popup's window.name. Only the
 * unique name we registered for our own window.open is consumed, and each
 * creation has its own name, so a site popup cannot steal another creation's
 * token.
 */
export function consumeProgrammaticPopupName(name) {
  if (!name || !pendingNames.has(name)) return false;
  pendingNames.delete(name);
  return true;
}

function withContextQueue(context, fn) {
  const previous = creationQueues.get(context) || Promise.resolve();
  const next = previous.then(fn, fn);
  creationQueues.set(context, next.catch(() => {}));
  return next;
}

async function openNamedPopup(opener, name, timeoutMs) {
  pendingNames.add(name);
  let popupPromise;
  try {
    popupPromise = opener.waitForEvent('popup', { timeout: timeoutMs });
    const result = await opener.evaluate((targetName) => {
      try {
        const opened = window.open('about:blank', targetName, 'noopener');
        return opened === null ? 'null' : 'window';
      } catch {
        return 'error';
      }
    }, name);
    if (result === 'error') throw new Error('window.open threw');
    const page = await popupPromise;
    const actualName = await page.evaluate(() => window.name).catch(() => null);
    if (actualName !== name) {
      throw new Error(`popup name mismatch (expected ${name}, got ${actualName})`);
    }
    // noopener already removes the opener; belt and suspenders for engines that
    // keep it, so a loaded site cannot reach back into our anchor page.
    await page.evaluate(() => { try { window.opener = null; } catch { /* ignore */ } }).catch(() => {});
    pendingNames.delete(name);
    return page;
  } catch (err) {
    // A page can still arrive after our timeout. Keep the unique name reserved
    // briefly so the popup handler skips it, and close it instead of leaving a
    // phantom managed tab.
    setTimeout(() => pendingNames.delete(name), 10000).unref?.();
    if (popupPromise) popupPromise.then((page) => page.close().catch(() => {})).catch(() => {});
    throw err;
  }
}

async function ensureAnchor(context, { log, timeoutMs }) {
  const existing = anchors.get(context);
  if (existing && !existing.isClosed?.()) return existing;

  const opener = context.pages().find((page) => !page.isClosed?.() && !anchorPages.has(page));
  if (!opener) return null;

  const name = `camofox-anchor-${randomUUID()}`;
  const anchor = await openNamedPopup(opener, name, timeoutMs);
  anchorPages.add(anchor);
  anchors.set(context, anchor);
  log('debug', 'window.open anchor tab created', { name });
  return anchor;
}

export async function createPageInContext(context, {
  reason = 'tab',
  log = () => {},
  timeoutMs = 10000,
  innerTimeoutMs = Math.min(2500, Math.max(500, Math.floor(timeoutMs / 3))),
} = {}) {
  const canTab = typeof context.pages === 'function'
    && typeof context.waitForEvent === 'function';
  if (!canTab) {
    const page = await context.newPage();
    tracePageCreated(page, context, reason, { openedVia: 'newPage' });
    return { page, openedVia: 'newPage' };
  }

  return withContextQueue(context, async () => {
    const pages = context.pages().filter((page) => !page.isClosed?.());
    if (pages.length === 0) {
      const page = await context.newPage();
      tracePageCreated(page, context, reason, { openedVia: 'newPage' });
      return { page, openedVia: 'newPage' };
    }

    let anchor = null;
    try {
      anchor = await ensureAnchor(context, { log, timeoutMs: innerTimeoutMs });
    } catch (err) {
      log('warn', 'window.open anchor creation failed, falling back to newPage', {
        reason,
        error: err.message,
      });
    }

    if (anchor) {
      try {
        const page = await openNamedPopup(anchor, `camofox-tab-${randomUUID()}`, innerTimeoutMs);
        tracePageCreated(page, context, reason, { openedVia: 'window.open' });
        return { page, openedVia: 'window.open' };
      } catch (err) {
        log('warn', 'window.open tab creation failed, falling back to newPage', {
          reason,
          error: err.message,
        });
      }
    }

    const page = await context.newPage();
    tracePageCreated(page, context, reason, { openedVia: 'newPage-fallback' });
    return { page, openedVia: 'newPage-fallback' };
  });
}
