'use strict';

/**
 * Backflow: put text from the side panel into the engine's chat composer.
 *
 * The panel and the chat are two different web contents, so this is the one
 * place that reaches across. Three things decide whether it works, and each was
 * settled by measuring against the running engine rather than by reasoning:
 *
 * 1. **Finding the composer.** The engine's component classes are content
 *    hashed (`uV2eYG_input`), so a selector built from them breaks on the next
 *    engine release. The composer is identified structurally instead: the
 *    largest visible text entry on the page. The only other text input in the
 *    chat view is the session search box — an `<input>`, and tiny.
 *
 * 2. **Getting the engine to agree the text is there.** The composer is a
 *    React controlled input. Assigning `el.value` directly does nothing useful:
 *    React's value tracker sees no change, so the send button stays disabled
 *    and anything sent goes out empty — the text is visible and the app still
 *    considers the box empty. Writing through the *prototype's* value setter
 *    bypasses React's override, and the following `input` event is then treated
 *    as a genuine edit. Verified by watching the send button leave its disabled
 *    state, which is the only honest signal that the engine agrees.
 *
 * 3. **Not depending on focus.** Two other mechanisms produce real edits and
 *    both were measured to fail here: `document.execCommand('insertText')`
 *    returns false unless the document is focused, and Electron's
 *    `webContents.insertText` needs that web contents focused. The click that
 *    triggers this happens in the panel, so the chat view is exactly what does
 *    not have focus. The setter path needs no focus at all.
 *
 * Every step reports a status, so a failure (no session open, composer
 * read-only because no workspace is selected) is shown to the user instead of
 * silently doing nothing.
 */

/**
 * Build the snippet evaluated inside the chat view.
 * @param {string} text literal text to append to the composer
 */
function injectionScript(text) {
  return `(() => {
    const payload = ${JSON.stringify(text)};

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const area = (el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };

    // Structural identification — never class names, which are hashed.
    const target = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ].filter(visible).sort((a, b) => area(b) - area(a))[0];

    if (!target) return 'no-composer';
    if (target.readOnly || target.disabled) return 'not-editable';

    const proto = target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return 'no-setter';

    // Append to whatever draft is already there, with a separator.
    const before = target.value ?? '';
    const next = before && !/\\s$/.test(before) ? before + ' ' + payload : before + payload;

    // Reset the tracker first so React registers a change even if the text
    // happens to match what it last saw.
    if (target._valueTracker) target._valueTracker.setValue('');
    setter.call(target, next);
    target.dispatchEvent(new Event('input', { bubbles: true }));

    // Leave the caret at the end so the user can keep typing.
    try {
      target.focus();
      target.setSelectionRange(next.length, next.length);
    } catch { /* focus is a convenience here, not a requirement */ }

    return target.value === next ? 'ok' : 'not-accepted';
  })()`;
}

/**
 * Insert text into the chat composer.
 * @param {import('electron').WebContents | null} webContents the chat view
 * @param {string} text
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function insertIntoComposer(webContents, text) {
  if (!webContents || webContents.isDestroyed()) return { ok: false, reason: 'no-view' };
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty' };
  try {
    const status = await webContents.executeJavaScript(injectionScript(text), true);
    return status === 'ok' ? { ok: true } : { ok: false, reason: String(status) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { insertIntoComposer, injectionScript };
