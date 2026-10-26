/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BrowserMcpConfig, mountSessionMcp, registerBrowserCommand, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type { BrowserMcpAttachConfig, BrowserMcpLaunchConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Chrome Web Store page of the extension that bridges Playwright MCP to the user's own browser. */
export const PLAYWRIGHT_EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm'

/** The user's running Chrome or Edge, reached through the Playwright Extension and turned on per Session with `/browser`. */
export interface ExtensionConfig {
  /** Drive tabs of the user's own browser after they approve the extension's connection prompt. */
  mode: 'extension'
  /** Browser holding the extension; defaults to Chrome. */
  browser: 'chrome' | 'msedge'
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed Chromium launch, existing-browser attachment, or user-browser extension settings. */
export type Config = BrowserMcpConfig | ExtensionConfig

/** Configuration as written, before schema defaults apply. */
type ConfigInput = BrowserMcpAttachConfig
  | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean })
  | (Omit<ExtensionConfig, 'browser'> & { browser?: ExtensionConfig['browser'] })

/** Validate the launch, attachment, or extension configuration before activation. */
export const Config: Schema<ConfigInput, Config> = Schema.union([
  BrowserMcpConfig,
  Schema.object({
    mode: Schema.const('extension').required(),
    browser: Schema.union(['chrome', 'msedge'] as const).default('chrome'),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; browser state is not persisted by DSH.
 * Extension mode reaches the user's own browser and connects only Sessions that run `/browser`.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'extension') validateBrowserMcpConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli]
  if (config.mode === 'extension') {
    args.push('--browser', config.browser, '--extension')
  } else if (config.mode === 'attach') {
    args.push('--browser', 'chromium', '--cdp-endpoint', config.endpoint)
  } else {
    args.push('--browser', 'chromium', '--isolated')
    if (config.headless) args.push('--headless')
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  const control = mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    // The user's browser is one shared resource, like an attached one.
    exclusive: config.mode !== 'launch',
    command: process.execPath,
    args,
    env,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...config.mode === 'extension' ? { activation: 'command' as const } : {},
  })
  if (config.mode !== 'extension') return
  const browserName = config.browser === 'msedge' ? 'Edge' : 'Chrome'
  registerBrowserCommand(ctx, control, {
    browserName,
    firstUse: `The first browser action opens a Playwright Extension tab in ${browserName}: choose the tab to share and approve the connection. Needs the Playwright Extension: ${PLAYWRIGHT_EXTENSION_URL}`,
  })
}
