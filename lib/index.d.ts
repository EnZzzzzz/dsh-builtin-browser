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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "builtin-browser";
/** Environment variable the Desktop shell uses to publish its control port. */
export declare const CONTROL_PORT_ENV = "DSH_DESKTOP_BROWSER_PORT";
/** Plugin configuration. */
export interface Config {
    /** Whether the browser mounts when the plugin loads. Defaults to true. */
    enabled?: boolean;
    /**
     * Loopback control endpoint port. Takes precedence over the environment
     * variable and the Client-reported port; set it when the shell does not
     * forward `DSH_DESKTOP_BROWSER_PORT`.
     */
    controlPort?: number;
}
/**
 * Mount the built-in browser plugin.
 * @param ctx - Cordis context carrying the tools and web services.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
