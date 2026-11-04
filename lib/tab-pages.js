/**
 * Open a page as a TAB of an existing Firefox window.
 *
 * Juggler's Browser.newPage always calls Services.ww.openWindow, so every
 * context.newPage() is a new top-level window. A page script calling
 * window.open() goes through Firefox's own tab policy instead. With
 * browser.link.open_newwindow=3 (new tab) and restriction=0 (apply to all
 * window.open calls), that page becomes a tab in the existing window and
 * Playwright still emits it as a popup on the opener.
 *
 * The first context.newPage() is an about:blank ANCHOR page we own. It is
 * never navigated, never returned to callers and never counted as a tab.
 * Every user page, including the first, is opened from that anchor with a
 * unique window name and noopener. If the anchor dies it is recreated with
 * context.newPage(). No window.open ever runs in a page the site controls.
 *
 * Creation is serialised per context because Playwright resolves every pending
 * popup waiter with the same first page event.
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

/** Live pages a caller owns in a context: anchors and closed pages excluded. */
export function userPages(context) {
  return context.pages().filter((page) => !isAnchorPage(page) && !page.isClosed?.());
}

/**
 * Read a page's window.name with a real timeout. Playwright's
 * page.evaluate(fn, arg, { timeout }) does NOT accept a timeout in this
 * version (the third argument is only { exposeFunctions }), so the bound has
 * to be a Promise.race. Returns null on timeout, which means "not ours".
 */
export async function readWindowNameBounded(page, timeoutMs = 1000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([
      page.evaluate(() => window.name).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function consumeProgrammaticPopupName(name) {
  if (!name || !pendingNames.has(name)) return false;
  pendingNames.delete(name);
  return true;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
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
    const actualName = await readWindowNameBounded(page, 1000);
    if (actualName !== name) {
      throw new Error(`popup name mismatch (expected ${name}, got ${actualName})`);
    }
    await page.evaluate(() => { try { window.opener = null; } catch { /* ignore */ } }).catch(() => {});
    // Leave the unique name reserved briefly: a popup handler on the opener
    // may still inspect it, and deleting too early could register our page
    // a second time.
    setTimeout(() => pendingNames.delete(name), 2000).unref?.();
    return page;
  } catch (err) {
    // A page can still arrive after our timeout. Close it only if its window
    // name is the unique name we reserved, so a site popup is never touched.
    setTimeout(() => pendingNames.delete(name), 10000).unref?.();
    if (popupPromise) {
      popupPromise
        .then(async (page) => {
          const lateName = await readWindowNameBounded(page, 1000);
          if (lateName === name) await page.close().catch(() => {});
        })
        .catch(() => {});
    }
    throw err;
  }
}

async function ensureAnchor(context, { log, timeoutMs }) {
  const existing = anchors.get(context);
  if (existing && !existing.isClosed?.()) return existing;

  const anchor = await context.newPage();
  anchorPages.add(anchor);
  anchors.set(context, anchor);
  tracePageCreated(anchor, context, 'anchor', { openedVia: 'newPage' });
  log('debug', 'anchor tab created', {});
  return anchor;
}

async function createUserPage(context, { log, innerTimeoutMs }) {
  let anchor = await ensureAnchor(context, { log, timeoutMs: innerTimeoutMs });
  const name = `camofox-tab-${randomUUID()}`;
  try {
    const page = await openNamedPopup(anchor, name, innerTimeoutMs);
    tracePageCreated(page, context, 'tab', { openedVia: 'window.open' });
    return { page, openedVia: 'window.open' };
  } catch (err) {
    if (anchor.isClosed?.()) {
      // The anchor died; recreate it and retry once before falling back.
      anchor = await ensureAnchor(context, { log, timeoutMs: innerTimeoutMs });
      try {
        const page = await openNamedPopup(anchor, `camofox-tab-${randomUUID()}`, innerTimeoutMs);
        tracePageCreated(page, context, 'tab', { openedVia: 'window.open' });
        return { page, openedVia: 'window.open' };
      } catch (retryErr) {
        log('warn', 'anchor retry failed, falling back to newPage', { error: retryErr.message });
      }
    } else {
      log('warn', 'window.open tab creation failed, falling back to newPage', { error: err.message });
    }
  }

  const page = await context.newPage();
  tracePageCreated(page, context, 'tab', { openedVia: 'newPage-fallback' });
  return { page, openedVia: 'newPage-fallback' };
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

  return withContextQueue(context, () =>
    // The deadline starts after queue wait: a slow op ahead must not make this
    // creation look like a hung newContext and reset the whole session.
    withTimeout(createUserPage(context, { log, innerTimeoutMs }), timeoutMs, 'new page')
  );
}
