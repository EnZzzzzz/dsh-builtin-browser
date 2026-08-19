/**
 * In-page injection payload for the vendored Selector editor.
 *
 * Selector runs entirely inside the guest page (no Node integration), so this
 * module assembles the single `executeJavaScript` payload the webview runs:
 *
 *   1. seed `window.__SELECTOR_HOST__` (language + the sendPrompt outbox),
 *   2. inject the editor CSS as a `<style>` element,
 *   3. run the editor bundle.
 *
 * The bundle and CSS are text assets embedded in the client bundle (see the
 * generated ./selector-assets.ts), so nothing is fetched at runtime.
 *
 * @module dsh-builtin-browser/client/picker-script
 */

import { editorBundle, editorCss } from './selector-assets.js'

/** Id of the injected `<style>` element, so re-injection never duplicates it. */
const STYLE_ID = '__dsh_selector_style'

/** Guest global the `HOST.sendPrompt` seed writes the prompt text into. */
export const OUTBOX_KEY = '__dshSelectorOutbox'

/** Seed the host seam the editor's core.js reads before it initializes. */
const HOST_SEED = `window.__SELECTOR_HOST__ = { initialLang: 'zh', sendPrompt: function (text) { window.${OUTBOX_KEY} = text; } };`

/** Idempotently inject the editor stylesheet as a `<style>` element. */
const CSS_INJECT = `(function () {
  if (!document.getElementById('${STYLE_ID}')) {
    var style = document.createElement('style');
    style.id = '${STYLE_ID}';
    style.textContent = ${JSON.stringify(editorCss)};
    (document.head || document.documentElement).appendChild(style);
  }
})();`

/**
 * The full injection program, run in the guest via `webview.executeJavaScript`.
 * The editor bundle's own `.ai-editor-root` guard makes repeated injection a
 * soft resume, so double-clicking the ⌖ button never stacks instances.
 */
export function buildInjectionCode(): string {
  return `${HOST_SEED}\n${CSS_INJECT}\n${editorBundle}`
}

/**
 * The poll expression the GUI runs every 500 ms while picking. Reads-and-clears
 * the outbox and reports whether the editor root is still present, in one shot.
 */
export function buildPollExpression(): string {
  return `(function () {
    var text = window.${OUTBOX_KEY};
    window.${OUTBOX_KEY} = null;
    return { text: typeof text === 'string' ? text : null, present: !!document.querySelector('.ai-editor-root') };
  })()`
}

/** Tear the editor and its injected stylesheet down from the GUI. Safe after
 * the guest already destroyed the editor (the guards make it a no-op). */
export const DESTROY_EXPRESSION = `if (window.__SELECTOR_DESTROY__) { window.__SELECTOR_DESTROY__(); }
var __dshStyle = document.getElementById('${STYLE_ID}');
if (__dshStyle) { __dshStyle.remove(); }`
