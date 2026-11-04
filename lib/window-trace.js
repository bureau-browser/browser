/**
 * Debug-only window/context/page tracing for the headful window investigation.
 *
 * Enabled with CAMOFOX_TRACE_WINDOWS=1 (read once in lib/config.js). Every
 * Playwright BrowserContext creation/close and every page creation/close emits
 * exactly one JSON line to stdout, tagged `"msg":"window-trace"`, with the
 * reason the event happened (session create, dedicated tab, reaper, idle
 * shutdown, probe, restart, ...).
 *
 * This module owns no env reads and no network calls, so it stays outside the
 * OpenClaw scanner rule pairs. Callers pass a boolean from CONFIG.
 */

let enabled = false;
let contextSeq = 0;
let pageSeq = 0;

// context -> { id, reason, userId, tabId }
const tracedContexts = new Map();
// page -> { id, contextId }
const tracedPages = new Map();

function emit(event, fields) {
  const entry = {
    ts: new Date().toISOString(),
    level: 'info',
    msg: 'window-trace',
    event,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function fieldsOf(obj) {
  const out = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export function initWindowTrace(on) {
  enabled = on === true;
}

export function isWindowTraceEnabled() {
  return enabled;
}

export function traceContextCreated(context, reason, fields = {}) {
  if (!enabled) return context;
  const id = `ctx-${++contextSeq}`;
  tracedContexts.set(context, { id, reason, ...fieldsOf(fields) });
  emit('context_created', {
    contextId: id,
    reason,
    pid: process.pid,
    ...fieldsOf(fields),
  });
  return context;
}

export function traceContextClosed(context, reason, fields = {}) {
  if (!enabled) return;
  const info = tracedContexts.get(context);
  if (!info) {
    emit('context_closed', { contextId: null, reason, ...fieldsOf(fields) });
    return;
  }
  tracedContexts.delete(context);
  // Pages a context close takes with it still get their one page_closed line.
  for (const [page, pageInfo] of [...tracedPages.entries()]) {
    if (pageInfo.contextId !== info.id) continue;
    tracedPages.delete(page);
    emit('page_closed', {
      pageId: pageInfo.id,
      contextId: info.id,
      reason: `${reason}-context`,
    });
  }
  emit('context_closed', {
    contextId: info.id,
    reason,
    createdReason: info.reason,
    userId: info.userId,
    tabId: info.tabId,
    ...fieldsOf(fields),
  });
}

/**
 * Contexts closed implicitly by a browser-level close (idle shutdown, restart,
 * stop, shutdown) never reach traceContextClosed. Emit them here first so the
 * trace accounts for every context it opened.
 */
export function traceAllContextsClosed(reason, fields = {}) {
  if (!enabled) return;
  for (const [context, info] of [...tracedContexts.entries()]) {
    tracedContexts.delete(context);
    for (const [page, pageInfo] of [...tracedPages.entries()]) {
      if (pageInfo.contextId !== info.id) continue;
      tracedPages.delete(page);
      emit('page_closed', {
        pageId: pageInfo.id,
        contextId: info.id,
        reason: `${reason}-context`,
      });
    }
    emit('context_closed', {
      contextId: info.id,
      reason,
      createdReason: info.reason,
      userId: info.userId,
      tabId: info.tabId,
      ...fieldsOf(fields),
    });
  }
}

export function tracePageCreated(page, context, reason, fields = {}) {
  if (!enabled) return page;
  const id = `page-${++pageSeq}`;
  const contextId = tracedContexts.get(context)?.id || null;
  tracedPages.set(page, { id, contextId });
  emit('page_created', {
    pageId: id,
    contextId,
    reason,
    ...fieldsOf(fields),
  });
  return page;
}

export function tracePageClosed(page, reason, fields = {}) {
  if (!enabled) return;
  const info = tracedPages.get(page);
  if (!info) {
    emit('page_closed', { pageId: null, reason, ...fieldsOf(fields) });
    return;
  }
  tracedPages.delete(page);
  emit('page_closed', {
    pageId: info.id,
    contextId: info.contextId,
    reason,
    ...fieldsOf(fields),
  });
}

export async function newTracedPage(context, reason, fields = {}) {
  const page = await context.newPage();
  tracePageCreated(page, context, reason, fields);
  return page;
}

export async function closeTracedContext(context, reason, fields = {}) {
  traceContextClosed(context, reason, fields);
  return await context.close();
}
