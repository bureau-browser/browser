/**
 * Fill helpers with bounded actionability.
 *
 * locator.evaluate() inherits Playwright's 30 s default; a target that never
 * becomes attached can therefore burn the whole route budget before the fill
 * even starts. Bound the actionability probe separately from the fill.
 */

export const NON_FILLABLE_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio',
  'range', 'reset', 'submit',
]);

export async function assertLocatorFillable(locator, { timeout = 5000 } = {}) {
  const info = await locator.evaluate((el) => {
    const tagName = el.tagName?.toLowerCase?.() || '';
    const type = tagName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const role = el.getAttribute?.('role') || '';
    const contentEditable = el.isContentEditable;
    return { tagName, type, role, contentEditable };
  }, undefined, { timeout });
  if (info.contentEditable || info.tagName === 'textarea') return;
  if (info.tagName === 'input' && !NON_FILLABLE_INPUT_TYPES.has(info.type)) return;
  if (info.role === 'textbox' || info.role === 'searchbox') return;
  const target = info.type ? `${info.tagName}[type=${info.type}]` : (info.role ? `${info.tagName}[role=${info.role}]` : info.tagName || 'element');
  throw Object.assign(new Error(`Element ${target} is not fillable. Use click for buttons and other controls.`), {
    code: 'element_not_actionable',
    statusCode: 422,
  });
}

export async function fillLocator(locator, text, { timeout = 10000 } = {}) {
  await assertLocatorFillable(locator, { timeout: Math.min(5000, timeout) });
  await locator.fill(text, { timeout });
}
