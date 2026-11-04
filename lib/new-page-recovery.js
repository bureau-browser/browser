import { acquirePageLease, releasePageLease, setLeasedPage } from './page-lease.js';
import { createPageInContext } from './tab-pages.js';

export async function createPageWithSessionRecovery({
  userId,
  session,
  trace = false,
  timeoutMs,
  withTimeout,
  isTimeoutError,
  isDeadContextError,
  currentSession,
  destroySession,
  getSession,
  log,
}) {
  let lease = acquirePageLease(session);
  try {
    // The creation deadline starts after the per-context queue wait inside
    // createPageInContext, so a slow op ahead cannot look like a hung page.
    const created = await createPageInContext(session.context, { reason: 'tab', log, timeoutMs });
    const page = setLeasedPage(lease, created.page);
    return { session, page, lease };
  } catch (err) {
    releasePageLease(session, lease);
    if (!isTimeoutError(err) && !isDeadContextError(err)) throw err;

    log('warn', 'new page failed, recreating user session', {
      userId,
      error: err.message,
    });

    // Another request may already have replaced this session. Never tear down
    // a newer healthy context while recovering the one that failed.
    if (currentSession() === session) {
      await destroySession(userId, { reason: 'new_page_unresponsive' });
    }

    session = await getSession(userId, { trace });
    lease = acquirePageLease(session);
    try {
      const created = await createPageInContext(session.context, { reason: 'tab', log, timeoutMs });
      const page = setLeasedPage(lease, created.page);
      return { session, page, lease };
    } catch (retryErr) {
      releasePageLease(session, lease);
      throw retryErr;
    }
  }
}
