import { describe, expect, test } from '@jest/globals';
import { TabLock, acquireForOp } from '../../lib/tab-lock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('tab lock holder-aware queue budget', () => {
  test('a queued op waits for the holder remaining plus its own budget', async () => {
    const lock = new TabLock();
    const releaseHolder = await acquireForOp(lock, 100, 0); // long fill

    let acquiredAt = 0;
    const startedAt = Date.now();
    const queued = acquireForOp(lock, 40, 0).then((release) => {
      acquiredAt = Date.now();
      return release;
    });

    await sleep(80);
    releaseHolder();
    const releaseQueued = await queued;

    // It must not wait the old flat 35 s (or even the holder's full 100 ms
    // plus 40 ms is fine); the point is it resolves right after release.
    expect(acquiredAt - startedAt).toBeLessThan(500);
    releaseQueued();
  });

  test('holderRemainingMs shrinks and clears on release', async () => {
    const lock = new TabLock();
    const release = await acquireForOp(lock, 200, 0);
    const first = lock.holderRemainingMs();
    await sleep(30);
    const second = lock.holderRemainingMs();
    expect(second).toBeLessThanOrEqual(first);
    release();
    expect(lock.holderRemainingMs()).toBe(0);
  });
});
