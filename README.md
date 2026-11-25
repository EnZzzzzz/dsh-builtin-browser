# dsh-builtin-browser

给 Desktop 封装的 DeepSeek Harness 提供**内置浏览器**的双面插件:一个**原生右侧边栏标签页**(官方 `ui-sidebar-right` 的 tab 类型)+ 一套 **agent 遥控工具**。

## 它做了什么

1. **右侧边栏的原生浏览器，自带内部标签条**。点网页里的链接（`target="_blank"`）、弹窗或工具栏 `+`,都在**同一个浏览器内部**开新标签页,不会弹出系统窗口,也不会为每个网页占一个侧栏位置。按 `keepMounted` 语义,每个内部标签的 surface 常驻,切换时保留滚动位置、表单和前进/后退历史。
2. **右侧边栏的原生浏览器标签页**。通过官方两段式注册进场:
   - 第一段 `ctx.sidebarRightTabs.register(...)` 声明这个 tab 类型(id / kind / 多实例 / 常驻挂载 / 侧边栏 guide 卡片);
   - 第二段在 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 两个官方座位注册正文与标题,**键为 `dsh-builtin-browser`**。

   也就是说:标签条、停靠、分屏、浮动、关闭、右键菜单全部由官方右侧栏负责,本插件**只画一页内容**(导航工具栏 + 网页 surface + 通知条)。入口在侧边栏 guide 页的「内置浏览器」卡片、`browser.new` 快捷键(`⌘⇧T`),或代码里的 `ctx.sidebarRight.openTab('builtin-browser')`。
3. **12 个 agent 工具**:`browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` / `browser_stop` / `browser_eval` / `browser_content` / `browser_screenshot` / `browser_tab_list` / `browser_tab_new` / `browser_tab_switch` / `browser_tab_close`。
4. **标注拾取**:工具栏的 ⌖ 把 vendored Selector 编辑器注入当前页面,标注结果直接排进该标签页所属会话。

> **不再依赖旧座位**:旧版本的私有三件套(`sidebar.footer.action` 侧边栏按钮、`shell.overlay` 全屏悬浮面板、自带多标签条)与 `dsh-sidebar-live` 的耦合已全部移除;构建产物里不再出现这两个 slot 名。

真正的浏览器引擎不在 DSH 里,而在 Desktop 外壳(Electron)里:外壳用 `<webview>`(完整 Chromium guest)承载页面,并跑一个 loopback HTTP 控制端点。本插件是这个 webview 的**遥控器**——UI、工具、命令转发。`desktop/` 目录提供外壳侧完整代码。

## 架构

```
┌─ Electron Desktop 外壳 ──────────────────────────────────────┐
│  main.cjs (主进程)                                            │
│   · BrowserWindow 开启 webviewTag: true,加载 dsh web GUI      │
│   · loopback HTTP 控制端点  http://127.0.0.1:PORT/browser/command
│   · 端口写入 DSH_DESKTOP_BROWSER_PORT(harness 进程可见)       │
│  preload.cjs                                                  │
│   · window.desktopBridge = { isDesktopShell, browserPort }    │
│  ┌─ harness web GUI 页面 ─────────────────────────────────┐  │
│  │  Client 半区(本插件):                                    │  │
│  │   · ctx.sidebarRightTabs  → 声明「内置浏览器」tab 类型     │  │
│  │   · sidebar.right.pane.tab(.title) → 正文与标签标题       │  │
│  │     (官方右侧栏提供标签条/停靠/分屏/浮动)                  │  │
│  │   · window.__dshBrowser   → 页面侧命令控制器(当前标签页)  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
          ▲ ctx.web.fetch                        ▲ executeJavaScript
┌─ DSH Host (Node 进程) ───────────────────────────────────────┐
│  Host 半区(本插件):                                           │
│   · 读 DSH_DESKTOP_BROWSER_PORT 或 RPC 上报端口               │
│   · 注册 browser_* agent 工具                                  │
│   · 工具执行 → ctx.web.fetch → 外壳端点 → 页面控制器 → webview │
└──────────────────────────────────────────────────────────────┘
```

命令链路(agent 自动化):

```
browser_navigate("https://example.com")
  → ctx.web.fetch("http://127.0.0.1:PORT/browser/command?op=navigate&url=...")
  → Electron 主进程收到
  → win.webContents.executeJavaScript('window.__dshBrowser.command({op,url})')
  → 页面内 webview 元素执行 loadURL(url)
  → { ok, url, title } 原路返回给工具
```

控制器永远作用于**当前可见**的浏览器标签页(`claim()` 在挂载 / 可见 / 导航时更新指针),所以分屏里两个浏览器标签页不会互相抢命令。

## 文件

| 路径 | 说明 |
|---|---|
| `src/index.ts` | Host 半区:控制端口解析(RPC + 环境变量)+ 12 个 agent 工具 |
| `src/client/index.ts` | Client 半区入口:类型注册、正文/标题座位注册、`browser.new` 快捷键、控制器发布 |
| `src/client/definition.ts` | tab 类型定义(`multiple` / `keepMounted` / guide 卡片) |
| `src/client/BrowserTab.tsx` | 标签页正文:工具栏 + 页面 surface + 通知条 |
| `src/client/BrowserTitle.tsx` | 标签标题(地球图标 + 本地化文案) |
| `src/client/store.ts` | 每个标签页自己的页面 store、`localStorage` 检查点、`window.__dshBrowser` 控制器 |
| `src/client/pick-flow.ts` | 标注拾取流程(注入 / 轮询 / 发送到所属会话) |
| `src/client/locales.ts` | `builtinBrowser` 文案(en/zh),含命名空间声明 |
| `src/client/env.d.ts` | 少数未随发行版发布的 Client 类型补充(窄接口 / `sessionId` 座位) |
| `desktop/main.cjs` | Electron 主进程示例:窗口 + webviewTag + HTTP 控制端点 |
| `desktop/preload.cjs` | preload:注入 `window.desktopBridge`(外壳标记 + 端口) |
| `cordis.patch.yml` | bundle 层插入行(安装后挂载本插件) |
| `locale/*.json`、`icon.svg`、`docs/DETAIL.md` | 插件管理器展示用的标题/描述/图标/详情页 |

## 类型与构建

两侧都对齐**当前内核 0.2.2-rc.1**(cordis 4.1):

```sh
pnpm install
pnpm run typecheck   # Host + Client 两套 tsconfig
pnpm run build       # Host(lib/index.js)+ Selector 资产 + Client(lib/client.js)
```

- Client bundle 只 external Web 外壳静态模块表里的 10 个模块(react / react-dom / cordis / zod / `@deepseek-ai/dsh-client-store|ui-slots|ui-primitives|ui-dockkit` 等),其余一律内联——因为模块表答不出的 `require()` 会在运行时抛错。`tsdown.config.ts` 里列出了这张表。
- `src/client/env.d.ts` 只补了发行版没有单独发布的窄接口(`ctx.sidebarRight` / `sidebarRightTabs`)和 `SessionStandardProps.sessionId`;SlotMap、`PropsRuntime`、`PropsLocale`、`InjectFace`、locale/shortcut 服务全部来自真实包的 `.d.ts`。

## 集成步骤

### 1. 外壳侧(Electron,一次性)

```js
const { app, BrowserWindow } = require('electron')
const { createMainWindow, startBrowserEndpoint } = require('dsh-builtin-browser/desktop/main.cjs')

app.whenReady().then(async () => {
  // 顺序无关:端点按需读取窗口;端口通过 DSH_DESKTOP_BROWSER_PORT 暴露。
  await startBrowserEndpoint(() => mainWindowRef)
  createMainWindow()   // 内部已设 webviewTag: true + preload
})
```

三个关键点:

1. **`webviewTag: true`** —— 必须开启,否则页面里的 `<webview>` 元素不生效(会退化成 iframe)。
2. **preload 必须挂上**(`desktop/preload.cjs`)—— 页面靠 `window.desktopBridge` 判断自己在 shell 里。
3. **端口要能到 harness 进程** —— `startBrowserEndpoint` 会把端口写进 `process.env.DSH_DESKTOP_BROWSER_PORT`;spawn 启动的外壳要检查 `env` 传递。

### 2. 插件侧

```sh
cd dsh-builtin-browser && pnpm install && pnpm run build

# 安装到 profile
dsh plugin --profile web add /path/to/dsh-builtin-browser
```

重启后打开右侧边栏,guide 页出现「内置浏览器」卡片;agent 自动获得 `browser_*` 工具。

> **按预设可见性**:`browser_*` 工具默认对所有 agent 全局可见,但 `hideForPresets`
> 配置(默认 `['minimal']`,即极简模式)会把这些工具从对应预设的 agent 目录里
> 屏蔽掉。在 bundle 层或 profile `cordis.patch.yml` 里改 `builtin-browser` 行的
> `hideForPresets` 即可调整。

### 3. 验证

- 手动:右侧边栏 guide 里点「内置浏览器」→ 输入 `example.com` 回车 → 页面加载。
- 多标签:`⌘⇧T` 或工具栏 `+` 再开一个,可以分屏并排。
- agent:对会话说"打开 example.com 并告诉我标题",模型会调 `browser_navigate`。
- 工具失败提示 `browser control endpoint unavailable` → 检查外壳是否在跑、`DSH_DESKTOP_BROWSER_PORT` 是否可见。
- 工具提示 `no built-in browser tab is open` → 先在侧边栏打开(或让 agent 调 `browser_tab_new`)浏览器标签页。

## 端口发现(为什么有两套)

Host 半区解析控制端口的优先级:

1. `config.controlPort`(cordis.yml 显式配置,最高)
2. `DSH_DESKTOP_BROWSER_PORT` 环境变量(外壳标准做法)
3. Client 半区 RPC 上报:`window.desktopBridge.browserPort` → `/builtin-browser` RPC `register-port` 端点(兜底)

## 安全说明

- 控制端点只监听 `127.0.0.1`,且只接受 `op` 白名单命令(`navigate/back/forward/reload/stop/eval/content/screenshot/tab-*`);`eval` 直接执行页面内 JS,因此这个端点**不要**暴露到非 loopback。
- `webview` 是隔离的 Chromium guest,不继承页面 Node 权限;`allowpopups` 按需保留。
- 本插件只转发命令,不代理流量;cookie/登录态存在 webview 的持久 session(`partition="persist:dsh-browser"`)里;guest 使用去掉 Electron 标记的标准 Chrome UA,以通过常见的 bot 检测(如 Cloudflare)。
- 截图由外壳主进程 `capturePage` 落盘到系统临时目录(`dsh-browser-screenshot-*.png`),路径经端点返回给 agent。

## 后续可扩展

- 截图内联给模型:`browser_screenshot` 目前落盘返回路径;如果 harness 的 attachment 服务开放给插件,可改为直接返回 image ContentBlock。
- 复用官方 Browser 标签页的 webview 租约(`window.dshDesktop.browser`),让本插件不再需要自己的控制端点;目前官方 bridge 不暴露 `executeJavaScript` / `capturePage`,所以仍走自建端点。
