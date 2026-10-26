/** Session-owned MCP browser processes and provider catalog activation. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionResources } from './index.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
  /**
   * When a Session connects: `agent` (default) awaits the server during each Agent's creation;
   * `command` leaves new Sessions without the browser until {@link SessionMcpControl.connect}.
   */
  activation?: 'agent' | 'command'
}

/** Per-Session connection control for command-activated browsers. */
export interface SessionMcpControl {
  /**
   * Start the browser server for one live Session and expose its tools from that Session's next step.
   * @param agent - exact live Agent that will own the browser.
   * @param signal - optional cancellation of this wait; acquisition remains Session-owned.
   * @returns whether a new connection was made rather than an existing one kept.
   * @throws when another Session holds an exclusive browser or the server fails to start.
   */
  connect(agent: Agent, signal?: AbortSignal): Promise<boolean>
  /**
   * Stop one Session's browser server and remove its tools, releasing an exclusive browser.
   * @param agent - exact live Agent.
   * @returns whether the Session was connected.
   */
  disconnect(agent: Agent): Promise<boolean>
  /**
   * @param agent - exact live Agent.
   * @returns whether the Session's browser tools are active.
   */
  connected(agent: Agent): boolean
}

interface ClientState {
  status: 'ready' | 'blocked'
  mask?: Scope
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, prompt assembly, and working directories.
 * @param options - provider identity, attachment exclusivity, executable configuration, and activation.
 * @returns connection control; only `command` activation needs it.
 * @throws when the working-directory provider is absent, before browser resources are registered.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): SessionMcpControl {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) throw new Error(`${options.name}: browser MCP requires a working-directory provider`)
  let resources!: SessionResources<Scope>
  const clients = new Map<Agent, ClientState>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status !== 'blocked') continue
        const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: await workingDirectory.ensure(agent, signal),
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            close() {
              clients.delete(agent)
              return scope.dispose()
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (options.activation === 'command') return
    const state: ClientState = { status: resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'blocked') {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    await resources.get(agent, signal)
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    return resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      try {
        return await next()
      } finally {
        exec.signal = original
      }
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
  return {
    async connect(agent, signal) {
      if (clients.get(agent)?.status === 'ready') return false
      if (stopping || !resources.available(agent)) {
        throw new Error(`${options.name}: the browser is in use by another Session; turn it off there first`)
      }
      await resources.get(agent, signal)
      // open() registered the Session's cleanup; its close() removes this state again.
      clients.set(agent, { status: 'ready' })
      return true
    },
    disconnect: agent => resources.release(agent),
    connected: agent => clients.get(agent)?.status === 'ready',
  }
}

/** How `/browser` describes and checks one user-browser provider. */
export interface BrowserCommandOptions {
  /** Display name of the user's browser, such as `Chrome`. */
  browserName: string
  /** What happens on the first browser action, shown when control turns on. */
  firstUse: string
  /**
   * Check that the user's browser can accept a connection before the Session connects.
   * @returns setup instructions when it cannot, otherwise undefined.
   */
  preflight?: () => Promise<string | undefined>
}

/**
 * Register `/browser [on|off|status]`, which connects the invoking Session to the user's own browser.
 * The command child activates only when a command registry is composed.
 * @param ctx - provider context.
 * @param control - per-Session control from a `command`-activated {@link mountSessionMcp}.
 * @param options - display text and the provider's readiness check.
 */
export function registerBrowserCommand(ctx: Context, control: SessionMcpControl, options: BrowserCommandOptions): void {
  const help = 'Use /browser to let this session control your browser, /browser off to stop, /browser status to check.'
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'browser',
      description: `Let this session control your ${options.browserName} tabs`,
      input: { hint: '[on|off|status]' },
      handler: async ({ agent, rawInput }) => {
        const action = rawInput.trim().toLowerCase() || 'on'
        if (action === 'status') {
          return { kind: 'success', text: control.connected(agent)
            ? `Browser control is on for this session. ${options.firstUse}`
            : `Browser control is off for this session. ${help}` }
        }
        if (action === 'off') {
          return { kind: 'success', text: await control.disconnect(agent)
            ? `Browser control is off for this session. ${options.browserName} and its tabs stay open.`
            : 'Browser control was already off for this session.' }
        }
        if (action !== 'on') return { kind: 'error', text: `Unknown /browser option "${action}". ${help}` }
        if (control.connected(agent)) return { kind: 'success', text: 'Browser control is already on for this session.' }
        const setup = await options.preflight?.()
        if (setup !== undefined) return { kind: 'error', text: setup }
        try {
          await control.connect(agent)
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
        return {
          kind: 'success',
          text: `Browser control is on for this session. Ask me to do something in ${options.browserName}.
${options.firstUse}
Use /browser off to stop.`,
        }
      },
    })
  })
}
