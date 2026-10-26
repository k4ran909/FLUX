import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123 })
  expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect('default' in Provider).toBe(false)
})

it('supports headed launch and attaches without launching a browser or creating a profile', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated'])
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[1]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
})

it('rejects malformed endpoints before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost:bad/path' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('reaches the user\'s browser through the extension only for Sessions that run /browser', async () => {
  const control = { connect: vi.fn(async () => true), disconnect: vi.fn(async () => true), connected: vi.fn(() => false) }
  vi.mocked(mountSessionMcp).mockReturnValue(control)
  let command: CommandDefinition | undefined
  const ctx = new Context()
  ctx.provide('commands', { register(next: CommandDefinition) { command = next; return () => { command = undefined } } } as never)
  Provider.apply(ctx, Provider.Config({ mode: 'extension' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options).toMatchObject({ exclusive: true, activation: 'command' })
  expect(options.args.slice(1)).toEqual(['--browser', 'chrome', '--extension'])
  await vi.waitFor(() => { expect(command?.name).toBe('browser') })

  const agent = {} as CommandInvocation['agent']
  const invoke = (rawInput: string) => command!.handler({ agent, rawInput } as CommandInvocation)
  await expect(invoke('')).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining(Provider.PLAYWRIGHT_EXTENSION_URL) })
  expect(control.connect).toHaveBeenCalledWith(agent)
  await expect(invoke(' status')).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('off for this session') })
  await expect(invoke(' off')).resolves.toEqual({ kind: 'success', text: 'Browser control is off for this session. Chrome and its tabs stay open.' })
  expect(control.disconnect).toHaveBeenCalledWith(agent)
  control.connect.mockRejectedValueOnce(new Error('playwright-mcp: the browser is in use by another Session; turn it off there first'))
  await expect(invoke(' on')).resolves.toEqual({ kind: 'error', text: 'playwright-mcp: the browser is in use by another Session; turn it off there first' })
  await expect(invoke(' launch')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('Unknown /browser option "launch"') })

  Provider.apply(new Context(), Provider.Config({ mode: 'extension', browser: 'msedge' }))
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].args.slice(1)).toEqual(['--browser', 'msedge', '--extension'])
})
