import { describe, expect, test, jest } from '@jest/globals';
import { createContextResilient } from '../../lib/new-context.js';

function timeoutError(message) {
  return new Error(`${message} timed out after 20000ms`);
}

describe('createContextResilient', () => {
  test('recycles the browser and retries once when newContext hangs', async () => {
    const context = { marker: 'context' };
    const restartBrowser = jest.fn(async () => {});
    const ensureBrowser = jest.fn(async () => ({ newContext: hungNewContext }));
    let calls = 0;
    const hungNewContext = jest.fn(async () => {
      calls++;
      if (calls === 1) return new Promise(() => {});
      return context;
    });

    const result = await createContextResilient({ viewport: null }, {
      ensureBrowser,
      restartBrowser,
      timeoutMs: 20,
      withTimeout: (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(timeoutError(label)), ms)),
      ]),
      isTimeoutError: (err) => /timed out after/.test(err.message),
      log: () => {},
    });

    expect(result).toBe(context);
    expect(calls).toBe(2);
    expect(restartBrowser).toHaveBeenCalledWith('newcontext_timeout');
    expect(ensureBrowser).toHaveBeenCalledTimes(2);
  });
});
