/**
 * Per-tab inactivity reaper.
 *
 * Kept as a pure tick function so the server's real reaping policy is
 * unit-testable without booting Express, the browser, or timers.
 *
 * Callbacks borrowed from the server:
 *  - hasActivePageLeases(session)
 *  - onTabReaped({ userId, tabId, listItemId, idleMs, tabState })
 *  - onSessionEmpty(userId, session)
 */
export function runTabReaperTick({
  sessions,
  tabInactivityMs,
  now = Date.now(),
  hasActivePageLeases = () => false,
  onTabReaped = () => {},
  onSessionEmpty = () => {},
}) {
  let reaped = 0;
  for (const [userId, session] of sessions) {
    // 0 (or negative) disables reaping entirely; keepAlive protects a session
    // whose tabs must survive idle time (for example a human signing in).
    if (tabInactivityMs <= 0 || session.keepAlive) continue;

    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        if (!tabState._lastReaperCheck) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (tabState.toolCalls === tabState._lastReaperToolCalls) {
          const idleMs = now - tabState._lastReaperCheck;
          if (idleMs >= tabInactivityMs) {
            onTabReaped({ userId, tabId, listItemId, idleMs, tabState });
            group.delete(tabId);
            reaped++;
          }
        } else {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
        }
      }
      if (group.size === 0) {
        session.tabGroups.delete(listItemId);
      }
    }

    if (session.tabGroups.size === 0 && !hasActivePageLeases(session) && !session._closing) {
      session._closing = true;
      onSessionEmpty(userId, session);
    }
  }
  return reaped;
}
