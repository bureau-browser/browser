import { isKeepAlive, browserInUse, summarizeSessions, sweepExpiredSessions } from '../../lib/session-policy.js';

const mk = (lastAccess, extra = {}, tabs = 1) => ({
  lastAccess,
  tabGroups: new Map([['g', new Map(Array.from({ length: tabs }, (_, i) => [`t${i}`, {}]))]]),
  ...extra,
});

describe('session policy', () => {
  test('isKeepAlive is strictly true only', () => {
    expect(isKeepAlive({ keepAlive: true })).toBe(true);
    expect(isKeepAlive({ keepAlive: 'yes' })).toBe(false);
    expect(isKeepAlive({})).toBe(false);
    expect(isKeepAlive(undefined)).toBe(false);
  });

  test('any session, keepAlive or not, pins the browser', () => {
    expect(browserInUse(new Map())).toBe(false);
    expect(browserInUse(new Map([['a', mk(0)]]))).toBe(true);
    expect(browserInUse(new Map([['a', mk(0, { keepAlive: true })]]))).toBe(true);
  });

  test('summarizeSessions exposes keepAlive, tab count and ISO lastAccess', () => {
    const sessions = new Map([
      ['a', mk(1_700_000_000_000, { keepAlive: true }, 2)],
      ['b', mk(1_700_000_001_000)],
    ]);
    expect(summarizeSessions(sessions)).toEqual([
      { userId: 'a', keepAlive: true, tabs: 2, lastAccess: '2023-11-14T22:13:20.000Z' },
      { userId: 'b', keepAlive: false, tabs: 1, lastAccess: '2023-11-14T22:13:21.000Z' },
    ]);
  });

  test('sweepExpiredSessions calls onExpire before deleting and honours the timeout boundary', () => {
    const sessions = new Map([['old', mk(0)], ['fresh', mk(900)]]);
    const seen = [];
    const expired = sweepExpiredSessions(sessions, {
      now: 1000,
      timeoutMs: 500,
      onExpire: (userId) => seen.push([userId, sessions.has(userId)]),
    });
    expect(expired).toEqual(['old']);
    expect(seen).toEqual([['old', true]]);
    expect([...sessions.keys()]).toEqual(['fresh']);
  });
});
