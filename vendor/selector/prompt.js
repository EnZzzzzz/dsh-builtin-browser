  // ── Prompt building ────────────────────────────────────────
  // Design-Feedback-style markdown: each picked element carries enough
  // location context (selector, DOM path, bounds, computed styles, HTML) for
  // an AI to find it again later. `Browser tab id` only appears when the host
  // seeds HOST.tabId (the builtin-browser plugin); the free bookmarklet omits
  // the line.
  function buildPromptText() {
    if (selectedElements.length === 0) return "";
    let pathname = "/";
    try { pathname = (location.pathname + location.hash) || "/"; } catch(_) {}
    const lines = [`## Design Feedback: ${pathname}`, "", `**URL:** ${location.href}`];
    if (HOST.tabId !== undefined && HOST.tabId !== null) lines.push(`**Browser tab id:** ${HOST.tabId}`);
    lines.push(`**Viewport:** ${window.innerWidth}x${window.innerHeight}`, "");
    selectedElements.forEach((el, i) => {
      const aiId = el.getAttribute(AI_ID);
      const note = annotations.get(aiId);
      const ctx = buildElementContext(el, i + 1, note);
      const reactChain = ctx.react ? ctx.react.split(" › ").map(n => `<${n}>`).join(" ") : "";
      // Avoid the redundant `<Shell> Shell "..."` header: when the title's
      // kind IS the last React component name, show the tag instead.
      let title = ctx.title;
      const lastComp = ctx.react && ctx.react.split(" › ").pop();
      if (lastComp && title.startsWith(lastComp)) title = ctx.tag + title.slice(lastComp.length);
      lines.push(`### ${i + 1}. ${reactChain ? reactChain + " " : ""}${title}`);
      const selector = buildSelector(el);
      if (selector) lines.push(`**Selector:** \`${selector}\``);
      const pretty = prettyLocation(el);
      if (pretty) lines.push(`**Location:** \`${pretty}\``);
      if (reactChain) lines.push(`**React:** ${reactChain}`);
      if (ctx.vue) lines.push(`**Vue:** ${ctx.vue.split(" › ").map(n => `<${n}>`).join(" ")}`);
      if (ctx.source) lines.push(`**Source:** ${ctx.source}`);
      lines.push(`**Bounds:** ${boundsStr(el)}`);
      if (ctx.text) lines.push(`**Text:** "${ctx.text}"`);
      const nearby = nearbyElements(el);
      if (nearby.length) lines.push("**Nearby elements:**", ...nearby.map(s => `- ${s}`));
      lines.push("**Computed styles:**", ...computedStylesList(el).map(s => `- ${s}`));
      lines.push(`**Full DOM path:** \`${fullDomPath(el)}\``);
      if (ctx.inside) lines.push(`**Inside:** ${ctx.inside}`);
      if (ctx.parent) lines.push(`**Parent:** ${ctx.parent}`);
      if (ctx.reactProps) lines.push(`**Props:** ${ctx.reactProps}`);
      Object.entries(ctx.dataAttrs).forEach(([k, v]) => lines.push(`**${k}:** ${v}`));
      const testLocators = hostTestLocators(el);
      if (testLocators) lines.push(`**Test:** ${testLocators[0]}`);
      lines.push("**HTML:**", "````html", truncateHtml(el.outerHTML, 1500), "````");
      if (note) lines.push(`**Feedback:** ${note}`);
      lines.push("");
    });
    return lines.join("\n");
  }
