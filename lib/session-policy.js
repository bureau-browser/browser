function isKeepAlive(session) {
  return session?.keepAlive === true;
}

// A session (keepAlive or not) holds a live browser context, so any session pins the browser.
function browserInUse(sessions) {
  return sessions.size > 0;
}

function sweepExpiredSessions(sessions, { now, timeoutMs, onExpire }) {
  const expired = [];
  for (const [userId, session] of sessions) {
    if (isKeepAlive(session)) continue;
    if (now - session.lastAccess > timeoutMs) {
      onExpire?.(userId, session);
      sessions.delete(userId);
      expired.push(userId);
    }
  }
  return expired;
}

function reapIdleTabs(sessions, { now, inactivityMs, onTabReaped, onSessionEmpty }) {
  if (inactivityMs <= 0) return;
  for (const [userId, session] of sessions) {
    if (isKeepAlive(session)) continue;
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        if (!tabState._lastReaperCheck) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (tabState.toolCalls === tabState._lastReaperToolCalls) {
          const idleMs = now - tabState._lastReaperCheck;
          if (idleMs >= inactivityMs) {
            onTabReaped?.({ userId, listItemId, tabId, tabState, idleMs });
            group.delete(tabId);
          }
        } else {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
        }
      }
      if (group.size === 0) session.tabGroups.delete(listItemId);
    }
    if (session.tabGroups.size === 0) {
      onSessionEmpty?.(userId, session);
      sessions.delete(userId);
    }
  }
}

function summarizeSessions(sessions) {
  const out = [];
  for (const [userId, session] of sessions) {
    let tabs = 0;
    for (const group of session.tabGroups.values()) tabs += group.size;
    out.push({
      userId,
      keepAlive: isKeepAlive(session),
      tabs,
      lastAccess: new Date(session.lastAccess).toISOString(),
    });
  }
  return out;
}

export { isKeepAlive, browserInUse, sweepExpiredSessions, reapIdleTabs, summarizeSessions };
