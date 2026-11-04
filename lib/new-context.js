/**
 * Bounded context creation.
 *
 * newContext on a "connected" browser can still hang forever: a wedged
 * Camoufox process keeps the Juggler connection alive (isConnected() === true)
 * yet stops answering commands, so ensureBrowser hands back a zombie and the
 * await never settles. Bound it, recycle the browser on a timeout, retry once.
 */
export async function createContextResilient(options, {
  ensureBrowser,
  restartBrowser,
  timeoutMs = 20000,
  withTimeout,
  isTimeoutError,
  log = () => {},
}) {
  let browser = await ensureBrowser();
  try {
    return await withTimeout(browser.newContext(options), timeoutMs, 'newContext');
  } catch (err) {
    if (!isTimeoutError(err)) throw err;
    log('warn', 'newContext timed out - browser connected but wedged, recycling', { error: err.message });
    await restartBrowser('newcontext_timeout');
    browser = await ensureBrowser();
    return await withTimeout(browser.newContext(options), timeoutMs, 'newContext(retry)');
  }
}
