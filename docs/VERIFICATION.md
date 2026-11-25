# Verification notes

What was verified for the sidebar-tab migration, and what still needs a human.

## Verified

- **Typecheck.** `tsc -p tsconfig.json` (Host) and `tsc -p tsconfig.client.json`
  (Client) both pass against the running kernel's published declarations
  (0.2.2-rc.5; cordis 4.1.0).
- **Build.** `tsc -p tsconfig.json && node vendor/selector/build.mjs && tsdown`
  emits `lib/index.js` and `lib/client.js`. The client bundle requests exactly
  two modules, `react` and `react/jsx-runtime`, both of which are platform seed
  words, so no request can miss the module table.
- **No legacy slots.** The built bundle contains no `sidebar.footer.action` and
  no `shell.overlay` reference; the only slot names it registers into are
  `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`.
- **Registration flow.** Loading `lib/client.js` through a mock module table and
  applying it to a mock Cordis context registers: the locale namespace, the
  page-side controller, the tab type (`builtin-browser`, `multiple`,
  `keepMounted`, one guide capsule), both keyed seats under the id
  `dsh-builtin-browser`, and the `builtinBrowser.new` shortcut.
- **Component output.** Server-rendering `BrowserTab` produces the toolbar
  (back / forward / reload / stop / address / new tab), the frame notice when no
  Desktop bridge is present, and the iframe fallback — with no `data-slot-error`.
  `BrowserTitle` renders the globe plus the localized label.
- **Live installation.** `install_bundle` returned `application: applied` with
  no warnings. Live slot inspection shows `dsh-builtin-browser` as an ACTIVE
  occupant of both `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`,
  and all twelve `browser_*` tools are registered on the Host.
- **Compatibility.** The plugin's `@deepseek-ai/dsh-*` peer ranges all satisfy
  the running kernel version, so startup does not deny the plugin the way it
  denies a plugin still pinned to `0.1.0-rc.6`.

## Needs a human

- **The rendered tab has not been seen.** This session runs a `web` profile, so
  the browser tab renders its iframe fallback and the Harness browser tool cannot
  reach the loopback GUI (the fetch provider denies it). Open the Desktop app,
  open the right Sidebar, and pick **内置浏览器** from the guide to see the real
  webview.
- **Real page navigation has not been exercised.** `browser_navigate` needs the
  Desktop shell's control endpoint. Confirm that
  `DSH_DESKTOP_BROWSER_PORT` reaches the harness process, then run
  `browser_navigate` with a public URL.
- **The ⌖ element picker has not run** against a live guest.
- **The icon has not been rendered.** `icon.svg` parses as well-formed XML and
  is under the size limit, but no rasterizer was available here (the sandbox
  blocks `qlmanage`).

## Internal tab strip (links opening system windows)

Reported: clicking a video card opened a new OS window instead of another tab.
Cause: the `<webview>` had `allowpopups`, and nothing claimed the popup, so
Electron opened a real top-level window for every `target="_blank"`.

Fixed by making the browser own a tab strip:

- the store holds MANY internal tabs per sidebar tab, each with its own surface,
  title, and loading flag; surfaces stay mounted and are only hidden, so each
  keeps scroll position, form state, and history;
- a `new-window` listener calls `preventDefault()` and opens the URL as a new
  internal tab, so no system window appears;
- the controller's `tab-list` / `tab-new` / `tab-close` / `tab-activate` ops now
  address the internal tabs, so `browser_tab_*` tools drive the same strip;
- with no browser mounted, `navigate` / `tab-new` now ask the Sidebar to open
  one (`ctx.sidebarRight.openTab`) and queue the URL, instead of failing because
  the user had not opened the panel.

Verified against the built bundle: `tab-new` / `navigate` / `tab-activate` /
`tab-close` round-trip through the real controller, the no-view path requests an
open and reports `pending`, and server-rendering the body emits
`role="tablist"`, one `role="tab"` per tab, a close control per tab, and one
surface. NOT verified: an actual click on a live page opening a tab — that needs
the Desktop webview.

## Single-row chrome and the restored tab animations

Reported: the tab strip sat on its own row above an always-visible address bar,
and the click-to-expand animation was gone.

- The bar is ONE row now: back / forward / reload / stop, the pill strip, then
  picking and the + button. The strip takes the remaining width and scrolls
  horizontally, so the page actions never get pushed out.
- There is no standalone address input. A pill shows its title; clicking the
  ACTIVE pill turns it into an inline editor that widens in place
  (flex-basis 220px / max-width 260px, 220ms), and clicking an inactive pill only
  switches. Enter commits, Escape reverts, blur commits without reloading an
  unchanged URL.
- New pills animate in from zero width (`dsh-bb-tab-in`, 200ms
  cubic-bezier(.22,1,.36,1)); closing pills play `dsh-bb-tab-out` (260ms) and stay
  mounted until `animationend`, then the store drops the tab.
- The + button opens a blank tab straight into its editor, so a new tab is
  ready for a URL on the first keystroke.

Verified by server-rendering the body and inspecting the emitted markup and
stylesheet: exactly one `.dsh-bb-bar`, no `.dsh-bb-tabs` row, no standalone
address input, the pill strip inside the toolbar, pills rendering their label
(no `<input>` in the static pass), and both keyframes plus the editing rule in
the stylesheet. NOT verified: the animation timing and the inline editor feel —
those need the running page.

## The last tab is not closeable

Reported: closing the only remaining (blank) tab dropped it and instantly
respawned a blank one, so the × looked broken.

- The close control is not rendered while one tab remains (`closeable =
  tabs.length > 1`), and the middle-click close respects the same rule.
- `store.closeTab` also returns early when one tab is left, so no caller —
  including `browser_tab_close` from an agent — can reintroduce the
  close-then-respawn cycle. The dead "respawn a blank tab" branch is gone.

Verified: server-rendering a fresh instance emits zero close controls
(`aria-label="关闭标签页"` count 0), and both guards are present in the source.

## Sizing fix (page cut off inside the panel)

A page could be cut off on the right and bottom. Three causes, two fixed here:

1. **Fixed: the surface resolved a percentage height against the root.** The
   toolbar's own height therefore pushed the page's bottom edge past the pane,
   and the guest sized its layout viewport from the inflated box. The surface is
   now `flex:1 1 auto` + `min-height:0` with no `height:100%`; the root gained
   `overflow:hidden` so a wide page can never move the toolbar. This matches the
   shipped Browser tab's own rules (`flex:auto;min-height:0`, no percentage
   height). Verified by rendering the component and reading the emitted rules.
2. **Fixed: missing `-webkit-app-region:no-drag`.** On macOS the pane sits in
   window chrome; a surface without this is a drag region, so clicks and scrolls
   land on the window instead of the page.
3. **NOT fixable in this plugin: desktop sites need more width than the pane.**
   `bilibili.com` and similar sites lay out for a viewport around 1000 px wide;
   a docked right-Sidebar pane is far narrower, so the site is clipped no matter
   how the frame is sized. The user's controls are the Sidebar's own: drag the
   column's divider to widen it, or put the pane in fullscreen/float mode via the
   Sidebar's presentation control. A plugin cannot change the panel geometry —
   `ctx.layout.openRightbar(track, fullscreen)` is the ceiling and it is the
   Sidebar's to call.

   If narrow-pane browsing matters, the honest next step is a page scale/Zoom
   control (offsetWidth x zoom = viewport) so a desktop layout fits the pane at
   ~0.5x. That is not implemented; it was out of scope for the kernel migration.

