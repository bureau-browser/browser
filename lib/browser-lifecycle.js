import crypto from 'crypto';

class BrowserCrashLoopError extends Error {
  constructor(failures) {
    super(`Browser is crash-looping after ${failures} consecutive failures; launches are paused until an explicit POST /start`);
    this.name = 'BrowserCrashLoopError';
    this.code = 'browser_crash_looping';
    this.statusCode = 503;
    this.expose = true;
  }
}

class BrowserLaunchTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Browser launch timeout (${Math.round(timeoutMs / 1000)}s)`);
    this.name = 'BrowserLaunchTimeoutError';
    this.code = 'browser_launch_timeout';
  }
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function withDeadline(promise, ms, setTimer, clearTimer) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimer(resolve, ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimer(timer));
}

function createBrowserLifecycle({
  getBrowser,
  clearBrowser,
  launch,
  launchTimeoutMs,
  crashLoopThreshold,
  idleTimeoutMs,
  browserInUse,
  isRecovering = () => false,
  children = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
  closeTimeoutMs = 10000,
}) {
  const bootId = crypto.randomUUID();
  const startedAt = now();

  let launchPromise = null;
  let launchStartedAt = null;
  let launchedAt = null;
  let lastLaunchMs = null;
  let lastRestartReason = null;
  let lastRestartAt = null;
  let launchFailures = 0;
  let contextFailures = 0;
  let idleTimer = null;

  const isConnected = (b) => !!b && (b.isConnected?.() ?? true);
  const isCrashLooping = () => launchFailures >= crashLoopThreshold || contextFailures >= crashLoopThreshold;

  function browserState() {
    if (isCrashLooping()) return 'crash-looping';
    if (launchPromise || isRecovering()) return 'launching';
    return isConnected(getBrowser()) ? 'running' : 'idle';
  }

  function recordLaunchFailure(err, startedMono) {
    launchFailures++;
    lastLaunchMs = now() - startedMono;
    log('warn', 'browser launch failed', { error: err.message, consecutiveLaunchFailures: launchFailures, threshold: crashLoopThreshold });
    if (isCrashLooping()) {
      log('error', 'browser crash-looping, pausing launches until an explicit start', { consecutiveLaunchFailures: launchFailures, consecutiveContextFailures: contextFailures });
    }
  }

  function startLaunch() {
    const attempt = { cancelled: false };
    const startedMono = now();
    launchStartedAt = startedMono;

    const inner = (async () => {
      const baseline = children ? await children.begin() : null;
      return new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimer(() => {
          if (settled) return;
          settled = true;
          attempt.cancelled = true;
          const err = new BrowserLaunchTimeoutError(launchTimeoutMs);
          recordLaunchFailure(err, startedMono);
          if (children) children.reapSince(baseline).catch(() => {});
          reject(err);
        }, launchTimeoutMs);

        launch({ isCancelled: () => attempt.cancelled }).then(
          async (b) => {
            clearTimer(timer);
            if (settled) {
              if (getBrowser() === b) clearBrowser();
              await b?.close?.().catch(() => {});
              return;
            }
            settled = true;
            if (children) await children.adopt(baseline).catch(() => {});
            launchFailures = 0;
            launchedAt = now();
            lastLaunchMs = launchedAt - startedMono;
            resolve(b);
          },
          async (err) => {
            clearTimer(timer);
            if (settled) return;
            settled = true;
            recordLaunchFailure(err, startedMono);
            if (children) await children.reapSince(baseline).catch(() => {});
            reject(err);
          },
        );
      });
    })();

    const p = inner.finally(() => {
      if (launchPromise === p) {
        launchPromise = null;
        launchStartedAt = null;
      }
    });
    launchPromise = p;
    return p;
  }

  function resetCrashLoop() {
    launchFailures = 0;
    contextFailures = 0;
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimer(idleTimer);
      idleTimer = null;
    }
  }

  async function ensure({ explicit = false } = {}) {
    clearIdleTimer();
    if (explicit) resetCrashLoop();
    const b = getBrowser();
    if (b) return b;
    if (launchPromise) return launchPromise;
    if (isCrashLooping()) throw new BrowserCrashLoopError(Math.max(launchFailures, contextFailures));
    return startLaunch();
  }

  async function closeCurrent() {
    const b = getBrowser();
    clearBrowser();
    if (b) await withDeadline(Promise.resolve(b.close?.()).catch(() => {}), closeTimeoutMs, setTimer, clearTimer);
    if (children) await children.reapCurrent().catch(() => {});
  }

  function noteRestart(reason) {
    lastRestartReason = reason;
    lastRestartAt = now();
  }

  function noteContextFailure() {
    contextFailures++;
    if (isCrashLooping()) {
      log('error', 'browser crash-looping (newContext keeps timing out), pausing restarts until an explicit start', { consecutiveContextFailures: contextFailures });
    }
    return isCrashLooping();
  }

  function noteContextOk() {
    contextFailures = 0;
  }

  function scheduleIdleShutdown() {
    if (idleTimer || idleTimeoutMs <= 0) return;
    if (browserInUse() || !getBrowser()) return;
    idleTimer = setTimer(async () => {
      idleTimer = null;
      if (browserInUse() || !getBrowser()) return;
      log('info', 'browser idle shutdown (no sessions)');
      await closeCurrent();
    }, idleTimeoutMs);
  }

  function snapshot() {
    return {
      bootId,
      startedAt: iso(startedAt),
      browserState: browserState(),
      launchedAt: iso(launchedAt),
      launchStartedAt: launchPromise ? iso(launchStartedAt) : null,
      lastLaunchMs,
      lastRestartReason,
      lastRestartAt: iso(lastRestartAt),
      launchBudgetMs: launchTimeoutMs,
      consecutiveLaunchFailures: launchFailures,
      consecutiveContextFailures: contextFailures,
      crashLoopThreshold,
    };
  }

  return {
    bootId,
    ensure,
    closeCurrent,
    noteRestart,
    noteContextFailure,
    noteContextOk,
    resetCrashLoop,
    isCrashLooping,
    isLaunching: () => !!launchPromise,
    scheduleIdleShutdown,
    clearIdleTimer,
    browserState,
    snapshot,
  };
}

export { createBrowserLifecycle, BrowserCrashLoopError, BrowserLaunchTimeoutError };
