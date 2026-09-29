function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  let seq = 0;
  const timers = new Map();

  function setTimer(fn, ms) {
    const id = ++seq;
    timers.set(id, { at: current + ms, fn });
    return id;
  }

  function clearTimer(id) {
    timers.delete(id);
  }

  async function advance(ms) {
    const target = current + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next.at)) {
          nextId = id;
          next = t;
        }
      }
      if (!next) break;
      timers.delete(nextId);
      current = next.at;
      next.fn();
      await flush();
    }
    current = target;
    await flush();
  }

  const sleep = (ms) => new Promise((resolve) => setTimer(resolve, ms));

  return { now: () => current, setTimer, clearTimer, advance, sleep, pending: () => timers.size };
}

export { createFakeClock, flush };
