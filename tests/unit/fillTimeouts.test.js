import { describe, expect, test, jest } from '@jest/globals';
import { assertLocatorFillable, fillLocator } from '../../lib/fill.js';

function hangingLocator() {
  return {
    evaluate: jest.fn((_fn, _arg, options = {}) => new Promise((_, reject) => {
      // Old code passed no timeout and would wait Playwright's 30 s default.
      if (options.timeout === undefined) return; // never settles in the test
      setTimeout(() => reject(new Error(`locator.evaluate timeout ${options.timeout}ms`)), options.timeout);
    })),
    fill: jest.fn(async () => {}),
  };
}

describe('bounded fill actionability', () => {
  test('a target whose evaluate never settles rejects at the actionability timeout', async () => {
    const locator = hangingLocator();
    const startedAt = Date.now();
    await expect(fillLocator(locator, 'x', { timeout: 40 })).rejects.toThrow(/timeout 40ms/);
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  test('a non-fillable element is rejected with 422 and no fill call', async () => {
    const locator = {
      evaluate: jest.fn(async () => ({ tagName: 'input', type: 'submit', role: '', contentEditable: false })),
      fill: jest.fn(),
    };
    await expect(assertLocatorFillable(locator)).rejects.toMatchObject({ statusCode: 422 });
  });
});
