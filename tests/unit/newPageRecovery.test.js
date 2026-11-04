import { describe, expect, jest, test } from '@jest/globals';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';

const isTimeoutError = err => err.code === 'timeout';
const isDeadContextError = err => err.code === 'dead_context';
const withTimeout = promise => promise;
const log = jest.fn();

function recoveryOptions(overrides) {
  return {
    userId: 'user-1',
    trace: false,
    timeoutMs: 10000,
    withTimeout,
    isTimeoutError,
    isDeadContextError,
    log,
    ...overrides,
  };
}

describe('createPageWithSessionRecovery', () => {
  test('replaces an unresponsive session and succeeds on one retry', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'fresh-page' };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue(page) } };
    let mappedSession = oldSession;
    const destroySession = jest.fn(async () => { mappedSession = null; });
    const getSession = jest.fn(async () => replacement);

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => mappedSession,
      destroySession,
      getSession,
    }));

    expect(destroySession).toHaveBeenCalledWith('user-1', { reason: 'new_page_unresponsive' });
    expect(getSession).toHaveBeenCalledWith('user-1', { trace: false });
    expect(result).toMatchObject({ session: replacement, page });
    expect(result.lease).toMatchObject({ page, released: false });
  });

  test('three concurrent creations whose window.open always fails do not destroy the session', async () => {
    class FakePage {
      constructor(name = '') { this.name = name; }
      isClosed() { return false; }
      async evaluate(fn, arg) {
        if (typeof arg === 'string') return null; // window.open opens nothing
        if (String(fn).includes('window.name')) return this.name;
        return null;
      }
      waitForEvent(event, { timeout } = {}) {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('popup timeout')), timeout || 500));
      }
    }
    class FakeContext {
      constructor() { this.pagesList = []; }
      pages() { return this.pagesList; }
      async newPage() { const page = new FakePage(); this.pagesList.push(page); return page; }
      waitForEvent() { return Promise.reject(new Error('unused')); }
    }

    const context = new FakeContext();
    const session = { context, pageLeases: new Set(), tabGroups: new Map() };
    const destroySession = jest.fn();
    const getSession = jest.fn();

    const results = await Promise.all([0, 1, 2].map(() => createPageWithSessionRecovery(recoveryOptions({
      session,
      timeoutMs: 1500,
      isTimeoutError: (err) => /timed out after/.test(err.message),
      currentSession: () => session,
      destroySession,
      getSession,
    }))));

    expect(destroySession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(new Set(results.map((r) => r.page)).size).toBe(3);
  });

  test('does not destroy a session another request already replaced', async () => {
    const deadError = Object.assign(new Error('context closed'), { code: 'dead_context' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(deadError) } };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue({ id: 'page' }) } };
    const destroySession = jest.fn();

    await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => replacement,
      destroySession,
      getSession: async () => replacement,
    }));

    expect(destroySession).not.toHaveBeenCalled();
  });

  test('retries only once', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const replacement = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
    }))).rejects.toThrow('new page timed out');

    expect(oldSession.context.newPage).toHaveBeenCalledTimes(1);
    expect(replacement.context.newPage).toHaveBeenCalledTimes(1);
  });

  test('does not recover unrelated failures', async () => {
    const error = new Error('programming error');
    const session = { context: { newPage: jest.fn().mockRejectedValue(error) } };
    const destroySession = jest.fn();

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession: jest.fn(),
    }))).rejects.toBe(error);

    expect(destroySession).not.toHaveBeenCalled();
  });
});
