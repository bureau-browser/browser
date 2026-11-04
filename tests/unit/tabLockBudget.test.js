import { describe, expect, test } from '@jest/globals';
import { TabLock, acquireForOp, handleTabLockQueueTimeout } from '../../lib/tab-lock.js';

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

  test('a caller deadline removes the queued entry so it never runs later', async () => {
    const lock = new TabLock();
    const releaseHolder = await acquireForOp(lock, 500, 0);
    let ran = false;
    const startedAt = Date.now();

    const queued = acquireForOp(lock, 35, 0, 100).then((release) => {
      ran = true;
      release();
    });

    // The cap must win over the holder-remaining + own-budget wait. On the
    // pre-fix code this rejects only after ~535 ms (holder 500 + own 35).
    await expect(queued).rejects.toThrow('Tab lock queue timeout');
    expect(Date.now() - startedAt).toBeLessThan(200);

    releaseHolder();
    await sleep(60);
    expect(ran).toBe(false);
  });

  test('a queue timeout on the server path returns 503 and leaves the tab alive', () => {
    const sessions = new Map([['user-1', { tabGroups: new Map([['list', new Map([['tab-1', {}]])]]) }]]);
    const res = {
      statusCode: null,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    handleTabLockQueueTimeout({
      res,
      extraFields: { reqId: 'r1' },
      sessions,
      userId: 'user-1',
      tabId: 'tab-1',
    });

    expect(res.statusCode).toBe(503);
    expect(res.payload.code).toBe('tab_unresponsive');
    expect(res.payload.retryable).toBe(true);
    expect(res.payload.reqId).toBe('r1');
    // The handler must not remove the tab from the session.
    expect(sessions.get('user-1').tabGroups.get('list').has('tab-1')).toBe(true);
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
