# dsh-builtin-browser

给 Desktop 封装的 DeepSeek Harness 提供**内置浏览器**的双面插件:侧边栏一个"内置浏览器"按钮,点开一个多标签的真浏览器面板(双击标签即可输入网址);同时给 agent 提供 `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` / `browser_stop` / `browser_eval` / `browser_content` / `browser_screenshot` / `browser_tab_list` / `browser_tab_new` / `browser_tab_switch` / `browser_tab_close` 工具,模型可以直接驱动这个浏览器(导航、读页面内容、截图、多标签管理)。

真正的浏览器引擎不在 DSH 里,而在你的 Desktop 外壳(Electron)里:外壳用 `<webview>` 元素(完整 Chromium guest)承载页面,并跑一个 loopback HTTP 控制端点;本插件只是这个 webview 的**遥控器**——UI、工具、命令转发。`desktop/` 目录提供外壳侧完整代码。

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
│  │   · sidebar.footer.action  → 「内置浏览器」开关按钮        │  │
│  │   · shell.overlay          → 悬浮面板(标签页+webview)    │  │
│  │   · window.__dshBrowser    → 页面侧命令控制器             │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
          ▲ ctx.web.fetch                        ▲ executeJavaScript
┌─ DSH Host (Node 进程) ───────────────────────────────────────┐
│  Host 半区(本插件):                                           │
│   · 读 DSH_DESKTOP_BROWSER_PORT 或 RPC 上报端口               │
│   · 注册 browser_navigate 等 agent 工具                        │
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

## 文件

| 路径 | 说明 |
|---|---|
| `src/index.ts` | Host 半区:控制端口解析(RPC + 环境变量)+ 12 个 agent 工具 |
| `src/client/` | Client 半区:侧边栏按钮、悬浮面板、共享 store、页面控制器 |
| `desktop/main.cjs` | Electron 主进程示例:窗口 + webviewTag + HTTP 控制端点 |
| `desktop/preload.cjs` | preload:注入 `window.desktopBridge`(外壳标记 + 端口) |
| `cordis.patch.yml` | bundle 层插入行(安装后挂载本插件) |

## 集成步骤

### 1. 外壳侧(Electron,一次性)

从 `desktop/main.cjs` 引入两个函数(或照抄其实现到你的主进程):

```js
const { app, BrowserWindow } = require('electron')
const { createMainWindow, startBrowserEndpoint } = require('dsh-builtin-browser/desktop/main.cjs')

app.whenReady().then(async () => {
  // 顺序无关:端点按需读取窗口;端口通过 DSH_DESKTOP_BROWSER_PORT 暴露,
  // dsh 进程(以及页面 preload)都能读到。
  await startBrowserEndpoint(() => mainWindowRef)
  createMainWindow()   // 内部已设 webviewTag: true + preload
})
```

三个关键点:

1. **`webviewTag: true`** —— 必须开启,否则页面里的 `<webview>` 元素不生效。
2. **preload 必须挂上**(`desktop/preload.cjs`)—— 页面靠 `window.desktopBridge` 判断自己在 shell 里;如果 preload 没注入,面板会降级成 iframe(很多网站拒绝被嵌)。
3. **端口要能到 harness 进程** —— `startBrowserEndpoint` 会把端口写进 `process.env.DSH_DESKTOP_BROWSER_PORT`。确保你的 dsh 子进程继承了这份环境(通常是同一环境自然继承);如果你的外壳是 spawn 启动的,检查 `env` 传递。

### 2. 插件侧

```sh
# 构建
cd builtin-browser && npm install && npm run build

# 安装到 profile(以 web profile 为例)
dsh plugin --profile web add /path/to/dsh-builtin-browser
```

重启后,侧边栏底部出现「🌐 内置浏览器」;agent 自动获得 `browser_*` 工具。

### 3. 验证

- 手动:点按钮 → 面板出现 → 双击标签(或点 + 新建)输入 `https://example.com` 回车。
- agent:直接对会话说"打开 example.com 并告诉我标题",模型会调 `browser_navigate`。
- 工具失败提示 `browser control endpoint unavailable` → 检查外壳是否在跑、`DSH_DESKTOP_BROWSER_PORT` 是否可见。

## 端口发现(为什么有两套)

Host 半区解析控制端口的优先级:

1. `config.controlPort`(cordis.yml 显式配置,最高)
2. `DSH_DESKTOP_BROWSER_PORT` 环境变量(外壳标准做法)
3. Client 半区 RPC 上报:`window.desktopBridge.browserPort` → `/builtin-browser` RPC `register-port` 端点(兜底,外壳不方便传环境变量时)

## 安全说明

- 控制端点只监听 `127.0.0.1`,且只接受 `op` 白名单命令(`navigate/back/forward/reload/stop/eval/content/screenshot/tab-*`);`eval` 直接执行页面内 JS,因此这个端点**不要**暴露到非 loopback。
- `webview` 是隔离的 Chromium guest,不继承页面 Node 权限;`allowpopups` 按需保留(新窗口交给 webview 自己处理)。
- 本插件只转发命令,不代理流量;cookie/登录态存在 webview 的持久 session(`partition="persist:dsh-browser"`)里;guest 使用去掉 Electron 标记的标准 Chrome UA,以通过常见的 bot 检测(如 Cloudflare)。
- 截图由外壳主进程 `capturePage` 落盘到系统临时目录(`dsh-browser-screenshot-*.png`),路径经端点返回给 agent。

## 后续可扩展

- 截图内联给模型:`browser_screenshot` 目前落盘返回路径;如果 harness 的 attachment 服务开放给插件,可改为直接返回 image ContentBlock。
- DevTools:`webview.openDevTools()` 从 `window.__dshBrowser` 暴露。
