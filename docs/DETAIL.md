# Built-in browser

A native browser tab for the right Sidebar that an agent can drive.

## What it adds

- **A right-sidebar tab type.** "Built-in browser" appears as a capsule on the
  sidebar's guide page and opens as an ordinary sidebar tab, beside Files,
  Terminal, and Document Preview. It docks, splits, floats, and closes with the
  rest of the column because it uses the product's own tab type registry — no
  private overlay or extra sidebar button.
- **Twelve agent tools.** `browser_navigate`, `browser_back`,
  `browser_forward`, `browser_reload`, `browser_stop`, `browser_eval`,
  `browser_content`, `browser_screenshot`, and `browser_tab_list` /
  `browser_tab_new` / `browser_tab_switch` / `browser_tab_close`, so the model
  can open a page, read its text, run a snippet, and screenshot it.

## Using it

1. Open the right Sidebar and pick **Built-in browser** from the guide.
2. Type an address in the toolbar and press Enter. A bare host becomes HTTPS;
   anything that is not a host is searched.
3. Ask the agent to look at the page, for example "open example.com and tell
   me the title".

Every open is an independent tab, so two pages can sit side by side. Pages
survive tab switches, sidebar collapse, and floating because the tab keeps its
webview mounted, and the address is checkpointed per Session and tab.

## Requirements and limits

- A real Chromium page needs the **Desktop shell**: it must open its window
  with `webviewTag: true`, load the `desktop/preload.cjs` bridge, and run the
  control endpoint from `desktop/main.cjs` so the Host half can reach the tab.
  Set `DSH_DESKTOP_BROWSER_PORT` (or `controlPort` in the row config) or let the
  Client report the port over the `/builtin-browser` RPC.
- Outside that shell the tab degrades to an `<iframe>` and the agent tools
  report the endpoint as unavailable; many sites refuse framing.
- `browser_*` tools are hidden from the presets named by `hideForPresets`
  (default: `minimal`).
- The element-picking button (⌖) sends an annotation into the Session that
  owns the tab; it needs the Desktop webview because cross-origin frames block
  script injection.
