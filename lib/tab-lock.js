/**
 * Per-tab mutex with holder-aware queueing.
 *
 * A queued operation must be allowed to wait for the operation ahead of it to
 * finish plus its own budget. A long human-typed fill legitimately holds the
 * tab for a minute or more; a flat queue timeout would otherwise fire while
 * the holder is still doing real work.
 */
export class TabLock {
  constructor({ onTimeout, onDepthChange } = {}) {
    this.queue = [];
    this.active = false;
    this.holderBudgetMs = 0;
    this.holderStartedAt = 0;
    this.onTimeout = onTimeout || (() => {});
    this.onDepthChange = onDepthChange || (() => {});
  }

  acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.onTimeout();
        this.onDepthChange();
        reject(new Error('Tab lock queue timeout'));
      }, timeoutMs);
      this.queue.push(entry);
      this.onDepthChange();
      this._tryNext();
    });
  }

  release() {
    this.clearHolderBudget();
    this.active = false;
    this._tryNext();
    this.onDepthChange();
  }

  setHolderBudget(budgetMs) {
    this.holderBudgetMs = Math.max(0, Number(budgetMs) || 0);
    this.holderStartedAt = Date.now();
  }

  clearHolderBudget() {
    this.holderBudgetMs = 0;
    this.holderStartedAt = 0;
  }

  holderRemainingMs() {
    if (!this.active || this.holderBudgetMs <= 0) return 0;
    const elapsed = Date.now() - this.holderStartedAt;
    return Math.max(0, this.holderBudgetMs - elapsed);
  }

  _tryNext() {
    if (this.active || this.queue.length === 0) return;
    this.active = true;
    const entry = this.queue.shift();
    clearTimeout(entry.timer);
    this.onDepthChange();
    entry.resolve();
  }

  drain() {
    this.active = true;
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Tab destroyed'));
    }
    this.queue = [];
    this.onDepthChange();
  }
}

/**
 * Acquire a tab lock for an operation with `ownBudgetMs`, waiting for the
 * current holder's remaining budget plus this operation's own budget.
 * Returns an idempotent release function.
 */
export async function acquireForOp(lock, ownBudgetMs, minimumWaitMs = 0) {
  const waitMs = Math.max(minimumWaitMs, lock.holderRemainingMs() + ownBudgetMs);
  await lock.acquire(waitMs);
  lock.setHolderBudget(ownBudgetMs);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.release();
  };
}
