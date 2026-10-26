/** Chromium inspection and automation through the pinned Chrome DevTools MCP server. @module */

import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BrowserMcpConfig, mountSessionMcp, registerBrowserCommand, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type { BrowserMcpAttachConfig, BrowserMcpLaunchConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Chrome DevTools MCP browser provider. */
export const name = 'experimental-browser-use-chrome-devtools-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Chrome release channel whose running instance `user-chrome` mode connects to. */
export type ChromeChannel = 'stable' | 'beta' | 'dev' | 'canary'

/**
 * The user's running Chrome, reached through Chrome's own remote-debugging switch
 * (`chrome://inspect/#remote-debugging`, Chrome 144+) and turned on per Session with `/browser`.
 */
export interface UserChromeConfig {
  /** Connect to the user's running Chrome after they allow remote debugging. */
  mode: 'user-chrome'
  /** Chrome channel to connect to; defaults to stable. */
  channel: ChromeChannel
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed Chromium launch, existing-browser attachment, or user-Chrome settings. */
export type Config = BrowserMcpConfig | UserChromeConfig

/** Configuration as written, before schema defaults apply. */
type ConfigInput = BrowserMcpAttachConfig
  | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean })
  | (Omit<UserChromeConfig, 'channel'> & { channel?: ChromeChannel })

/** Validate the launch, attachment, or user-Chrome configuration before activation. */
export const Config: Schema<ConfigInput, Config> = Schema.union([
  BrowserMcpConfig,
  Schema.object({
    mode: Schema.const('user-chrome').required(),
    channel: Schema.union(['stable', 'beta', 'dev', 'canary'] as const).default('stable'),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/** Instructions for turning on Chrome's remote-debugging switch. */
export const REMOTE_DEBUGGING_SETUP = [
  'Chrome is not accepting a connection yet. To let FLUX use your browser:',
  '1. Open Google Chrome.',
  '2. Go to chrome://inspect/#remote-debugging',
  '3. Turn on "Allow remote debugging for this browser instance".',
  'Then run /browser again. Chrome asks you to approve the connection on the first browser action.',
].join('\n')

/**
 * Locate the user-data directory Chrome uses for one channel, which holds its `DevToolsActivePort` file.
 * @param channel - Chrome release channel.
 * @param platform - Host platform.
 * @param env - Environment supplying `LOCALAPPDATA` on Windows.
 * @returns the channel's default user-data directory.
 */
export function chromeUserDataDir(channel: ChromeChannel, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const folder = { stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome SxS' }[channel]
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', folder, 'User Data')
  }
  if (platform === 'darwin') {
    const folder = { stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome Canary' }[channel]
    return join(homedir(), 'Library', 'Application Support', 'Google', folder)
  }
  const folder = { stable: 'google-chrome', beta: 'google-chrome-beta', dev: 'google-chrome-unstable', canary: 'google-chrome-canary' }[channel]
  return join(homedir(), '.config', folder)
}

/**
 * Check that Chrome's remote-debugging switch is on and the running instance listens.
 * The `DevToolsActivePort` file outlives a closed Chrome, so its port must also accept a connection.
 * @param userDataDir - Chrome user-data directory.
 * @returns setup instructions when Chrome cannot accept a connection, otherwise undefined.
 */
export async function checkRemoteDebugging(userDataDir: string): Promise<string | undefined> {
  let port: number
  try {
    port = Number.parseInt((await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/u)[0] ?? '', 10)
  } catch {
    return REMOTE_DEBUGGING_SETUP
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return REMOTE_DEBUGGING_SETUP
  const listening = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => { socket.destroy(); resolve(value) }
    socket.setTimeout(1500, () => { finish(false) })
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
  return listening ? undefined : REMOTE_DEBUGGING_SETUP
}

/**
 * Expose Chrome DevTools' upstream catalog through one MCP process per live Session.
 * Attached browsers remain externally owned; the server disables usage statistics.
 * `user-chrome` mode reaches the user's running Chrome and connects only Sessions that run `/browser`.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'user-chrome') validateBrowserMcpConfig(config)
  const cli = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
  const args = [cli, '--no-usage-statistics']
  if (config.mode === 'user-chrome') {
    // Performance tools would otherwise send the user's page URLs to Google's CrUX API.
    args.push('--autoConnect', '--channel', config.channel, '--no-performance-crux')
  } else if (config.mode === 'attach') {
    args.push(/^wss?:/u.test(config.endpoint) ? '--ws-endpoint' : '--browser-url', config.endpoint)
  } else {
    args.push('--isolated', `--headless=${String(config.headless)}`)
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  const control = mountSessionMcp(ctx, {
    name: 'chrome-devtools-mcp',
    // The user's running Chrome is one shared resource, like an attached browser.
    exclusive: config.mode !== 'launch',
    command: process.execPath,
    args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...config.mode === 'user-chrome' ? { activation: 'command' as const } : {},
  })
  if (config.mode !== 'user-chrome') return
  const userDataDir = chromeUserDataDir(config.channel)
  registerBrowserCommand(ctx, control, {
    browserName: 'Chrome',
    firstUse: 'Chrome asks you to approve the connection on the first browser action.',
    preflight: () => checkRemoteDebugging(userDataDir),
  })
}
