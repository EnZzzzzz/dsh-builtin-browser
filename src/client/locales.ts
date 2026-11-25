/**
 * Copy for the built-in browser tab, registered as the `builtinBrowser` locale
 * namespace so the chip, the guide capsule, the toolbar, and the notices follow
 * the active language without re-registering anything.
 *
 * The namespace is declared where the dictionaries are (below), so a missing or
 * misspelled key is a compile error at the registration site and at every `t()`
 * call, exactly as the shipped Client packages declare their own copy.
 *
 * @module dsh-builtin-browser/client/locales
 */

/** Locale namespace owned by this package. */
export const NS = 'builtinBrowser'

/** Every string this package renders. */
export type BuiltinBrowserKey =
  | 'type.label'
  | 'guide.title'
  | 'guide.description'
  | 'address.placeholder'
  | 'nav.back'
  | 'nav.forward'
  | 'nav.reload'
  | 'nav.stop'
  | 'tab.new'
  | 'picking.on'
  | 'picking.off'
  | 'pick.sent'
  | 'pick.crossOrigin'
  | 'pick.notReady'
  | 'pick.noSession'
  | 'pick.sessionClosed'
  | 'shell.required'
  | 'send.unavailable'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by this package. */
    builtinBrowser: BuiltinBrowserKey
  }
}

/** Chinese copy (the user's language). */
const zh: Record<BuiltinBrowserKey, string> = {
  'type.label': '内置浏览器',
  'guide.title': '内置浏览器',
  'guide.description': '在侧边栏浏览网页，并让助手直接读取页面',
  'address.placeholder': '输入网址后回车',
  'nav.back': '后退',
  'nav.forward': '前进',
  'nav.reload': '刷新',
  'nav.stop': '停止',
  'tab.new': '新建浏览器标签',
  'picking.on': '退出元素拾取',
  'picking.off': '拾取元素发给助手',
  'pick.sent': '标注已发送给助手',
  'pick.crossOrigin': '浏览器安全策略禁止标注跨域页面（iframe 模式）；请使用 Desktop 外壳',
  'pick.notReady': '浏览器页面尚未就绪，请稍后再试',
  'pick.noSession': '会话服务不可用',
  'pick.sessionClosed': '该浏览器标签所属的会话已关闭',
  'shell.required': '内置浏览器需要 Desktop 外壳提供 webview；当前已降级为 iframe，部分网站无法打开',
  'send.unavailable': '标注发送服务不可用',
}

/** English copy. */
const en: Record<BuiltinBrowserKey, string> = {
  'type.label': 'Built-in browser',
  'guide.title': 'Built-in browser',
  'guide.description': 'Browse the web beside the conversation and let the agent read the page',
  'address.placeholder': 'Enter a URL and press Enter',
  'nav.back': 'Back',
  'nav.forward': 'Forward',
  'nav.reload': 'Reload',
  'nav.stop': 'Stop',
  'tab.new': 'New browser tab',
  'picking.on': 'Stop picking elements',
  'picking.off': 'Pick an element for the agent',
  'pick.sent': 'Annotation sent to the agent',
  'pick.crossOrigin': 'This browser blocks annotating cross-origin pages in iframe mode; use the Desktop shell',
  'pick.notReady': 'The browser page is not ready yet; try again in a moment',
  'pick.noSession': 'The session service is unavailable',
  'pick.sessionClosed': 'The session this browser tab belongs to has closed',
  'shell.required': 'The built-in browser needs the Desktop webview; this environment falls back to an iframe, so some sites will not load',
  'send.unavailable': 'The annotation service is unavailable',
}

/** Every dictionary this package registers, keyed by locale id. */
export const LOCALES = { zh, en }
