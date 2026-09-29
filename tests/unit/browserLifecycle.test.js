import { createBrowserLifecycle, BrowserCrashLoopError } from '../../lib/browser-lifecycle.js';
import { loadConfig } from '../../lib/config.js';
import { browserInUse, sweepExpiredSessions, reapIdleTabs } from '../../lib/session-policy.js';
import { createFakeClock, flush } from '../helpers/fakeClock.js';

function makeHarness({ launchMs = 0, launchTimeoutMs = 120000, crashLoopThreshold = 3, idleTimeoutMs = 300000, children = null, launchImpl = null } = {}) {
  const clock = createFakeClock();
  const sessions = new Map();
  const state = { browser: null, launches: 0, closed: [], launchMs };
  const logs = [];

  const makeBrowser = () => {
    const b = { connected: true, isConnected: () => b.connected, close: async () => { b.connected = false; state.closed.push(b); } };
    return b;
  };

  const launch = launchImpl
    ? (ctx) => launchImpl(ctx, { state, clock, makeBrowser })
    : async (ctx) => {
        state.launches++;
        if (state.launchMs > 0) await clock.sleep(state.launchMs);
        const b = makeBrowser();
        if (ctx.isCancelled()) return b;
        state.browser = b;
        return b;
      };

  const lifecycle = createBrowserLifecycle({
    getBrowser: () => state.browser,
    clearBrowser: () => { state.browser = null; },
    launch,
    launchTimeoutMs,
    crashLoopThreshold,
    idleTimeoutMs,
    browserInUse: () => browserInUse(sessions),
    children,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (level, msg, fields) => logs.push({ level, msg, ...fields }),
  });
  return { clock, sessions, state, lifecycle, logs };
}

describe('config: launch budget env', () => {
  const KEYS = ['CAMOFOX_LAUNCH_TIMEOUT_MS', 'CAMOFOX_NEWCONTEXT_TIMEOUT_MS', 'CAMOFOX_CRASH_LOOP_THRESHOLD'];
  const saved = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('defaults: 120s launch budget, 60s newContext, threshold 3', () => {
    const cfg = loadConfig();
    expect(cfg.launchTimeoutMs).toBe(120000);
    expect(cfg.newContextTimeoutMs).toBe(60000);
    expect(cfg.crashLoopThreshold).toBe(3);
  });

  test('env overrides are respected', () => {
    process.env.CAMOFOX_LAUNCH_TIMEOUT_MS = '5000';
    process.env.CAMOFOX_NEWCONTEXT_TIMEOUT_MS = '7000';
    process.env.CAMOFOX_CRASH_LOOP_THRESHOLD = '5';
    const cfg = loadConfig();
    expect(cfg.launchTimeoutMs).toBe(5000);
    expect(cfg.newContextTimeoutMs).toBe(7000);
    expect(cfg.crashLoopThreshold).toBe(5);
    expect(cfg.serverEnv.CAMOFOX_LAUNCH_TIMEOUT_MS).toBe('5000');
  });

  test('a lifecycle built from the env budget enforces it', async () => {
    process.env.CAMOFOX_LAUNCH_TIMEOUT_MS = '5000';
    const cfg = loadConfig();
    const h = makeHarness({ launchMs: 6000, launchTimeoutMs: cfg.launchTimeoutMs });
    const p = h.lifecycle.ensure();
    const settled = p.then(() => 'ok', (e) => e.message);
    await h.clock.advance(5000);
    expect(await settled).toBe('Browser launch timeout (5s)');
  });
});

describe('bootId', () => {
  test('differs across a simulated restart (fresh lifecycle per process start)', () => {
    const a = makeHarness().lifecycle.snapshot();
    const b = makeHarness().lifecycle.snapshot();
    expect(a.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.bootId).not.toBe(b.bootId);
  });

  test('is stable for the life of the process, across browser restarts', async () => {
    const h = makeHarness();
    const before = h.lifecycle.snapshot().bootId;
    await h.lifecycle.ensure();
    await h.lifecycle.closeCurrent();
    await h.lifecycle.ensure();
    expect(h.lifecycle.snapshot().bootId).toBe(before);
  });

  test('startedAt is an ISO timestamp of process start', () => {
    const h = makeHarness();
    expect(h.lifecycle.snapshot().startedAt).toBe(new Date(h.clock.now()).toISOString());
  });
});

describe('browserState transitions', () => {
  test('idle -> launching -> running -> idle', async () => {
    const h = makeHarness({ launchMs: 30000 });
    expect(h.lifecycle.snapshot().browserState).toBe('idle');
    expect(h.lifecycle.snapshot().launchedAt).toBeNull();

    const p = h.lifecycle.ensure();
    await flush();
    let snap = h.lifecycle.snapshot();
    expect(snap.browserState).toBe('launching');
    expect(snap.launchStartedAt).toBe(new Date(h.clock.now()).toISOString());

    await h.clock.advance(30000);
    await p;
    snap = h.lifecycle.snapshot();
    expect(snap.browserState).toBe('running');
    expect(snap.launchedAt).toBe(new Date(h.clock.now()).toISOString());
    expect(snap.launchStartedAt).toBeNull();
    expect(snap.lastLaunchMs).toBe(30000);

    await h.lifecycle.closeCurrent();
    expect(h.lifecycle.snapshot().browserState).toBe('idle');
  });

  test('a disconnected browser reports idle, not running', async () => {
    const h = makeHarness();
    await h.lifecycle.ensure();
    h.state.browser.connected = false;
    expect(h.lifecycle.snapshot().browserState).toBe('idle');
  });

  test('concurrent ensure() calls share one launch', async () => {
    const h = makeHarness({ launchMs: 10000 });
    const a = h.lifecycle.ensure();
    const b = h.lifecycle.ensure();
    await h.clock.advance(10000);
    expect(await a).toBe(await b);
    expect(h.state.launches).toBe(1);
  });

  test('noteRestart records lastRestartReason', () => {
    const h = makeHarness();
    expect(h.lifecycle.snapshot().lastRestartReason).toBeNull();
    h.lifecycle.noteRestart('newcontext_timeout');
    const snap = h.lifecycle.snapshot();
    expect(snap.lastRestartReason).toBe('newcontext_timeout');
    expect(snap.lastRestartAt).toBe(new Date(h.clock.now()).toISOString());
  });

  test('isRecovering reports launching', () => {
    const clock = createFakeClock();
    let recovering = false;
    const lc = createBrowserLifecycle({
      getBrowser: () => null, clearBrowser: () => {}, launch: async () => ({}),
      launchTimeoutMs: 1000, crashLoopThreshold: 3, idleTimeoutMs: 0, browserInUse: () => false,
      isRecovering: () => recovering, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    recovering = true;
    expect(lc.browserState()).toBe('launching');
  });
});

describe('slow launches are not failures', () => {
  test('repeated 70s launches under a 120s budget never flip to crash-looping', async () => {
    const h = makeHarness({ launchMs: 70000, launchTimeoutMs: 120000, crashLoopThreshold: 3 });
    for (let i = 0; i < 5; i++) {
      const p = h.lifecycle.ensure();
      await h.clock.advance(70000);
      await p;
      const snap = h.lifecycle.snapshot();
      expect(snap.browserState).toBe('running');
      expect(snap.consecutiveLaunchFailures).toBe(0);
      expect(snap.lastLaunchMs).toBe(70000);
      await h.lifecycle.closeCurrent();
    }
    expect(h.state.launches).toBe(5);
    expect(h.lifecycle.isCrashLooping()).toBe(false);
  });

  test('a launch that finishes just inside the budget succeeds', async () => {
    const h = makeHarness({ launchMs: 119999, launchTimeoutMs: 120000 });
    const p = h.lifecycle.ensure();
    await h.clock.advance(119999);
    await p;
    expect(h.lifecycle.snapshot().browserState).toBe('running');
  });

  test('a failure followed by a success resets the failure streak', async () => {
    let calls = 0;
    const h = makeHarness({
      launchImpl: async (ctx, { state, makeBrowser }) => {
        calls++;
        if (calls <= 2) throw new Error('boom');
        state.browser = makeBrowser();
        return state.browser;
      },
    });
    await expect(h.lifecycle.ensure()).rejects.toThrow('boom');
    await expect(h.lifecycle.ensure()).rejects.toThrow('boom');
    expect(h.lifecycle.snapshot().consecutiveLaunchFailures).toBe(2);
    await h.lifecycle.ensure();
    expect(h.lifecycle.snapshot().consecutiveLaunchFailures).toBe(0);
    expect(h.lifecycle.snapshot().browserState).toBe('running');
  });
});

describe('crash-looping', () => {
  test('after N consecutive failed launches launches stop until an explicit request', async () => {
    let calls = 0;
    const h = makeHarness({
      crashLoopThreshold: 3,
      launchImpl: async () => { calls++; throw new Error('cannot start'); },
    });
    for (let i = 0; i < 3; i++) await expect(h.lifecycle.ensure()).rejects.toThrow('cannot start');
    expect(calls).toBe(3);
    expect(h.lifecycle.snapshot().browserState).toBe('crash-looping');

    for (let i = 0; i < 5; i++) {
      await expect(h.lifecycle.ensure()).rejects.toBeInstanceOf(BrowserCrashLoopError);
    }
    expect(calls).toBe(3);
    expect(h.logs.some((l) => l.msg.includes('crash-looping'))).toBe(true);
  });

  test('the crash-loop error is a 503 with a stable code', async () => {
    const h = makeHarness({ crashLoopThreshold: 1, launchImpl: async () => { throw new Error('x'); } });
    await expect(h.lifecycle.ensure()).rejects.toThrow('x');
    const err = await h.lifecycle.ensure().catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('browser_crash_looping');
  });

  test('an explicit ensure resets the counters and launches again', async () => {
    let fail = true;
    const h = makeHarness({
      crashLoopThreshold: 2,
      launchImpl: async (ctx, { state, makeBrowser }) => {
        if (fail) throw new Error('down');
        state.browser = makeBrowser();
        return state.browser;
      },
    });
    for (let i = 0; i < 2; i++) await expect(h.lifecycle.ensure()).rejects.toThrow('down');
    expect(h.lifecycle.isCrashLooping()).toBe(true);
    fail = false;
    await h.lifecycle.ensure({ explicit: true });
    expect(h.lifecycle.isCrashLooping()).toBe(false);
    expect(h.lifecycle.snapshot().browserState).toBe('running');
  });

  test('launches that blow the budget count as failures and end in crash-looping', async () => {
    const h = makeHarness({ launchMs: 500000, launchTimeoutMs: 120000, crashLoopThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      const settled = h.lifecycle.ensure().then(() => 'ok', (e) => e.message);
      await h.clock.advance(120000);
      expect(await settled).toBe('Browser launch timeout (120s)');
    }
    expect(h.lifecycle.snapshot().browserState).toBe('crash-looping');
    expect(h.lifecycle.snapshot().consecutiveLaunchFailures).toBe(3);
  });

  test('a launch that completes after its budget expired is closed, not adopted', async () => {
    const h = makeHarness({ launchMs: 200000, launchTimeoutMs: 120000 });
    const settled = h.lifecycle.ensure().then(() => 'ok', (e) => e.message);
    await h.clock.advance(120000);
    expect(await settled).toMatch(/launch timeout/);
    await h.clock.advance(80000);
    expect(h.state.browser).toBeNull();
    expect(h.state.closed).toHaveLength(1);
  });

  test('newContext timeouts count toward crash-looping and a healthy context resets them', () => {
    const h = makeHarness({ crashLoopThreshold: 3 });
    expect(h.lifecycle.noteContextFailure()).toBe(false);
    expect(h.lifecycle.noteContextFailure()).toBe(false);
    h.lifecycle.noteContextOk();
    expect(h.lifecycle.noteContextFailure()).toBe(false);
    expect(h.lifecycle.noteContextFailure()).toBe(false);
    expect(h.lifecycle.noteContextFailure()).toBe(true);
    expect(h.lifecycle.snapshot().browserState).toBe('crash-looping');
    expect(h.lifecycle.snapshot().consecutiveContextFailures).toBe(3);
  });
});

describe('keepAlive sessions vs reaper and idle browser timer', () => {
  const HOUR = 3600_000;

  function addSession(h, userId, { keepAlive, tabs = 1 } = {}) {
    const group = new Map();
    for (let i = 0; i < tabs; i++) group.set(`${userId}-tab${i}`, { toolCalls: 0, page: {} });
    const session = { tabGroups: new Map([['g', group]]), lastAccess: h.clock.now() };
    if (keepAlive) session.keepAlive = true;
    h.sessions.set(userId, session);
    return session;
  }

  test('tab reaper closes idle tabs of normal sessions but never a keepAlive session', () => {
    const h = makeHarness();
    addSession(h, 'normal');
    addSession(h, 'login', { keepAlive: true });
    const reaped = [];
    const emptied = [];
    const run = (nowMs) => reapIdleTabs(h.sessions, {
      now: nowMs,
      inactivityMs: 300000,
      onTabReaped: (r) => reaped.push(r.tabId),
      onSessionEmpty: (u) => emptied.push(u),
    });
    run(h.clock.now());
    run(h.clock.now() + 2 * HOUR);
    expect(reaped).toEqual(['normal-tab0']);
    expect(emptied).toEqual(['normal']);
    expect(h.sessions.has('normal')).toBe(false);
    expect(h.sessions.has('login')).toBe(true);
    expect(h.sessions.get('login').tabGroups.get('g').size).toBe(1);
  });

  test('a keepAlive session with no tabs left is not closed by the reaper either', () => {
    const h = makeHarness();
    const s = addSession(h, 'login', { keepAlive: true });
    s.tabGroups.clear();
    reapIdleTabs(h.sessions, { now: h.clock.now() + HOUR, inactivityMs: 1000 });
    expect(h.sessions.has('login')).toBe(true);
  });

  test('session timeout sweep skips keepAlive sessions', () => {
    const h = makeHarness();
    addSession(h, 'normal');
    addSession(h, 'login', { keepAlive: true });
    const expired = sweepExpiredSessions(h.sessions, { now: h.clock.now() + 2 * HOUR, timeoutMs: 600000 });
    expect(expired).toEqual(['normal']);
    expect(h.sessions.has('login')).toBe(true);
  });

  test('idle browser timer does not close the browser while a keepAlive session exists, and does once it is gone', async () => {
    const h = makeHarness({ idleTimeoutMs: 300000 });
    await h.lifecycle.ensure();
    addSession(h, 'login', { keepAlive: true });
    addSession(h, 'normal');

    sweepExpiredSessions(h.sessions, { now: h.clock.now() + HOUR, timeoutMs: 600000 });
    expect([...h.sessions.keys()]).toEqual(['login']);

    h.lifecycle.scheduleIdleShutdown();
    await h.clock.advance(HOUR);
    expect(h.state.browser).not.toBeNull();
    expect(h.state.closed).toHaveLength(0);
    expect(h.lifecycle.snapshot().browserState).toBe('running');

    h.sessions.delete('login');
    h.lifecycle.scheduleIdleShutdown();
    await h.clock.advance(300000);
    expect(h.state.browser).toBeNull();
    expect(h.state.closed).toHaveLength(1);
    expect(h.lifecycle.snapshot().browserState).toBe('idle');
  });

  test('a session created after the idle timer was armed cancels the shutdown', async () => {
    const h = makeHarness({ idleTimeoutMs: 300000 });
    await h.lifecycle.ensure();
    h.lifecycle.scheduleIdleShutdown();
    await h.clock.advance(200000);
    addSession(h, 'login', { keepAlive: true });
    await h.clock.advance(200000);
    expect(h.state.closed).toHaveLength(0);
  });

  test('ensure() cancels a pending idle shutdown', async () => {
    const h = makeHarness({ idleTimeoutMs: 300000 });
    await h.lifecycle.ensure();
    h.lifecycle.scheduleIdleShutdown();
    await h.lifecycle.ensure();
    expect(h.clock.pending()).toBe(0);
  });
});

describe('orphan reaping wiring', () => {
  test('a launch that times out reaps the children it spawned since the baseline', async () => {
    const calls = [];
    const children = {
      begin: async () => { calls.push('begin'); return new Set([1]); },
      adopt: async () => { calls.push('adopt'); },
      reapSince: async (baseline) => { calls.push(['reapSince', [...baseline]]); return []; },
      reapCurrent: async () => { calls.push('reapCurrent'); return []; },
    };
    const h = makeHarness({ launchMs: 500000, launchTimeoutMs: 120000, children });
    const settled = h.lifecycle.ensure().then(() => 'ok', (e) => e.message);
    await flush();
    await h.clock.advance(120000);
    await settled;
    expect(calls).toEqual(['begin', ['reapSince', [1]]]);
  });

  test('a successful launch adopts its children and closeCurrent reaps stragglers', async () => {
    const calls = [];
    const children = {
      begin: async () => new Set(),
      adopt: async () => { calls.push('adopt'); },
      reapSince: async () => { calls.push('reapSince'); return []; },
      reapCurrent: async () => { calls.push('reapCurrent'); return []; },
    };
    const h = makeHarness({ children });
    await h.lifecycle.ensure();
    await h.lifecycle.closeCurrent();
    expect(calls).toEqual(['adopt', 'reapCurrent']);
  });

  test('a hung browser.close() is abandoned after the close deadline and stragglers are still reaped', async () => {
    const calls = [];
    const children = {
      begin: async () => new Set(),
      adopt: async () => {},
      reapSince: async () => [],
      reapCurrent: async () => { calls.push('reapCurrent'); return [4242]; },
    };
    const h = makeHarness({ children });
    const b = await h.lifecycle.ensure();
    b.close = () => new Promise(() => {});
    const closing = h.lifecycle.closeCurrent();
    await flush();
    await h.clock.advance(10000);
    await closing;
    expect(h.state.browser).toBeNull();
    expect(calls).toEqual(['reapCurrent']);
  });
});
