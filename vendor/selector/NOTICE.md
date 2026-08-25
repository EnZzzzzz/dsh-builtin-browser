# Vendored Selector

This directory vendors the in-page editor from
[oil-oil/selector](https://github.com/oil-oil/selector) (MIT), snapshot pinned to
upstream commit `d57434c03675dccecdc1997a3a5f66674357d1f7` (2026-08-17 `main`).

## What was vendored

| Path | Source |
|---|---|
| `core.js`, `selection.js`, `ui.js`, `export.js`, `prompt.js`, `sharingan.js`, `context.js` | upstream `src/*.js` (the seven IIFE fragments) |
| `editor.css` | upstream `assets/editor.css` |
| `LICENSE` | MIT license text (upstream declares `MIT` in `README.md`) |

`build.mjs` assembles these fragments into `editor.bundle.js` using the same
concatenation order as upstream `scripts/build.js`
(`core → selection → ui → export → prompt → sharingan(strip header) → context`),
and then emits a TypeScript string module (`src/client/selector-assets.ts`) so
the bundle and CSS ship as text assets inside the client bundle.

## Local patches

Upgrade note: these patches are replayed by hand after re-vendoring. Keep them
small — that is the whole point of the minimal-patch rule.

1. **`export.js` — add a "发送到会话" (send-to-session) button.**

   Adds a `sendPrompt`-wired button immediately to the LEFT of the chat panel's
   "Copy Prompt" button. It calls `buildPromptText()` (the exact ⌘C text, incl.
   per-element `instruction:` lines) and forwards it to
   `window.__SELECTOR_HOST__.sendPrompt(text)` instead of the clipboard. The
   button is disabled while nothing is selected (kept in lockstep with Copy
   Prompt by wrapping `updateTags`), and it degrades to a no-op when the host
   does not provide `sendPrompt` (the free bookmarklet path).

   The button is injected by wrapping `createChatPanel` (the action-row markup
   lives in `ui.js`; the wrapper keeps the whole patch inside this one file) and
   is styled inline to mirror `.ai-editor-copy-btn` — it intentionally does NOT
   reuse that class, because `showCopyFeedback`/`copyBtnEl`/`updateTags` select
   the copy button via `.ai-editor-copy-btn` and would otherwise grab this one.

2. **`prompt.js` — Design-Feedback markdown output.**

   `buildPromptText()` is rewritten from the upstream plain `Page:`-led outline
   to a Design-Feedback-style markdown document (`## Design Feedback: {path}`,
   **URL:**, **Browser tab id:** when `HOST.tabId` is seeded, **Viewport:**,
   and per element **Selector:**/**Location:**/**React:/**/**Bounds:/**/
   **Computed styles:**/**Full DOM path:**/**HTML:**/**Feedback:**). The new
   location helpers (`domPathSegment`/`fullDomPath`/`prettyLocation`/
   `boundsStr`/`nearbyElements`/`computedStylesList`) live in `context.js`.

3. **dsh theming and annotation UX (core.js / ui.js / selection.js / editor.css).**

   DeepSeek-blue theme (`#4D6BFE`) for hover/selection overlays, buttons and
   feedback states; click-select auto-opens a large annotation editor (title +
   selector + multi-line input + cancel/add); the per-element floating pencil /
   copy-markdown buttons are removed (the popover opens on click-selection, so
   they were redundant); chat-panel tags show the element label with its
   annotation on a second gray line; DICT gained the `cancel`/`add` entries.

Everything else in the vendored files is byte-for-byte upstream.
