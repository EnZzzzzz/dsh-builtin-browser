/**
 * dsh-builtin-browser — a Cordis plugin (and dsh bundle) that adds a built-in
 * browser to a Desktop-wrapped DeepSeek Harness.
 *
 * The browser itself is a real Chromium `<webview>` rendered by the Desktop
 * shell (Electron, see desktop/ in this package): the shell creates the
 * webview surface inside the harness web GUI and runs a loopback HTTP control
 * endpoint (desktop/main.js). This host half is the agent's remote control:
 *
 *  1. The shell passes the endpoint port to the harness process through the
 *     `DSH_DESKTOP_BROWSER_PORT` environment variable (or the browser Client
 *     half reports it over the `/builtin-browser` Connection RPC channel as a
 *     fallback).
 *  2. The agent tools below forward commands to that endpoint through
 *     `ctx.web.fetch`, which the shell's endpoint turns into calls on the
 *     live `<webview>` element (`browser_navigate`, `browser_back`, ...).
 *
 * The plugin is a plain function plugin: named exports only, no default
 * export (see docs/postmortem/0001 in the harness repo).
 *
 * @module dsh-builtin-browser
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'builtin-browser';
/** Environment variable the Desktop shell uses to publish its control port. */
export const CONTROL_PORT_ENV = 'DSH_DESKTOP_BROWSER_PORT';
/** Loopback control endpoint hostname shared with the Desktop shell. */
const ENDPOINT_HOST = '127.0.0.1';
/**
 * Mount the built-in browser plugin.
 * @param ctx - Cordis context carrying the tools and web services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
    const enabled = config.enabled ?? true;
    if (!enabled) {
        ctx.logger.info('[builtin-browser] disabled; set enabled: true in cordis.yml to mount the browser');
        return;
    }
    // Mutable runtime state: the endpoint port and the last URL the agent told
    // the browser to open. The port comes from config > env > Client report.
    let reportedPort;
    let lastNavigatedUrl;
    const envPort = Number(process.env[CONTROL_PORT_ENV]);
    if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
        reportedPort = envPort;
        ctx.logger.info(`[builtin-browser] control endpoint from ${CONTROL_PORT_ENV}: ${envPort}`);
    }
    // --- Client→Host RPC fallback: the browser half reports the shell port. ---
    // ctx.inject takes exactly (deps, callback); the callback returns its
    // disposer and the fiber owns it (mirrors weixin-bridge).
    ctx.inject(['connection'], (apiCtx) => {
        return apiCtx.connection.rpc.handle('/builtin-browser', async (endpoint, payload, _signal) => {
            if (endpoint !== 'register-port') {
                return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } };
            }
            const port = Number(payload?.port);
            if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                return {
                    ok: false,
                    error: {
                        code: 'internal',
                        message: `invalid browser control port: ${String(payload?.port)}`,
                        details: {},
                    },
                };
            }
            reportedPort = port;
            ctx.logger.info(`[builtin-browser] control endpoint registered on port ${port} (RPC)`);
            return { ok: true, value: { port } };
        }, { authority: 'loopback' });
    });
    /** Resolve the endpoint, honoring an explicit config override first. */
    function resolveEndpoint() {
        const port = config.controlPort ?? reportedPort;
        if (!port)
            return null;
        const web = ctx.get('web');
        if (!web)
            return null;
        return {
            async command(payload) {
                const query = Object.entries(payload)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
                    .join('&');
                const result = await web.fetch({ url: `http://${ENDPOINT_HOST}:${port}/browser/command?${query}` });
                // The endpoint replies with a JSON body classified as text.
                const body = result.body;
                if (!body?.content)
                    return { ok: false, error: 'empty browser endpoint reply' };
                try {
                    return JSON.parse(body.content);
                }
                catch {
                    return { ok: false, error: `non-JSON browser endpoint reply: ${body.content.slice(0, 200)}` };
                }
            },
        };
    }
    /** Shared failure text for tools whose endpoint is not reachable. */
    function endpointUnavailable() {
        return {
            ok: false,
            error: `browser control endpoint unavailable: is the Desktop shell running with the webview and ${CONTROL_PORT_ENV} set?`,
        };
    }
    /** Render one navigation outcome as model-facing text. */
    function renderNavOutcome(toolName, _args, value) {
        const v = value;
        if (v.ok === false)
            return [{ type: 'text', text: `${toolName} failed: ${v.error ?? 'unknown error'}` }];
        return [{ type: 'text', text: `${toolName} → ${v.url ?? '?'} "${v.title ?? ''}"` }];
    }
    // --- Agent tools: the model drives the embedded browser. ---
    const navigateTool = defineTool({
        name: 'browser_navigate',
        description: 'Open a URL in the built-in Desktop browser and wait for the navigation to settle, returning the final page title and URL.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute URL to open, e.g. https://example.com' },
        },
        output: {
            schema: { type: 'json' },
            render: (args, value) => renderNavOutcome('browser_navigate', args, value),
        },
        async execute(args) {
            lastNavigatedUrl = String(args.url);
            const endpoint = resolveEndpoint();
            if (!endpoint)
                return endpointUnavailable();
            return endpoint.command({ op: 'navigate', url: lastNavigatedUrl });
        },
    });
    const navTool = (toolName, description, op) => defineTool({
        name: toolName,
        description,
        parameters: {},
        output: {
            schema: { type: 'json' },
            render: (args, value) => renderNavOutcome(toolName, args, value),
        },
        async execute() {
            const endpoint = resolveEndpoint();
            if (!endpoint)
                return endpointUnavailable();
            return endpoint.command({ op });
        },
    });
    const evalTool = defineTool({
        name: 'browser_eval',
        description: 'Run a JavaScript expression inside the current browser page and return its JSON-serializable result.',
        parameters: {
            script: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page context' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (v.ok === false)
                    return [{ type: 'text', text: `browser_eval failed: ${v.error ?? 'unknown error'}` }];
                return [{ type: 'text', text: `Result: ${JSON.stringify(v.result)}` }];
            },
        },
        async execute(args) {
            const endpoint = resolveEndpoint();
            if (!endpoint)
                return endpointUnavailable();
            return endpoint.command({ op: 'eval', script: String(args.script) });
        },
    });
    // Register every tool once the tools service is available; the inject
    // callback returns one disposer that unregisters all of them.
    ctx.inject(['tools'], (toolsCtx) => {
        const disposers = [
            navigateTool,
            navTool('browser_back', 'Go back one page in the built-in browser.', 'back'),
            navTool('browser_forward', 'Go forward one page in the built-in browser.', 'forward'),
            navTool('browser_reload', 'Reload the current page in the built-in browser.', 'reload'),
            navTool('browser_stop', 'Stop the current page load in the built-in browser.', 'stop'),
            evalTool,
        ].map((t) => toolsCtx.tools.register(t));
        return () => disposers.forEach((dispose) => dispose());
    });
    ctx.logger.info('[builtin-browser] mounted: browser_navigate / browser_back / browser_forward / browser_reload / browser_stop / browser_eval');
}
