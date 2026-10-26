import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => vi.clearAllMocks())

it('resolves the installed DevTools CLI and explicitly selects isolated headed or headless launch', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chrome', toolCallTimeoutMs: 456 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'chrome-devtools-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 456 })
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=true', '--executable-path', '/custom/chrome'])
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=false'])
  expect('default' in Provider).toBe(false)
})

it.each([
  ['http://127.0.0.1:9222', '--browser-url'],
  ['wss://browser.example/devtools/browser/id', '--ws-endpoint'],
])('attaches to %s without passing launch flags', (endpoint, flag) => {
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', flag, endpoint])
})

it('rejects trailing endpoint garbage before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost trailing-junk' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('connects the user\'s running Chrome through autoConnect only for Sessions that run /browser', async () => {
  const control = { connect: vi.fn(async () => true), disconnect: vi.fn(async () => true), connected: vi.fn(() => false) }
  vi.mocked(mountSessionMcp).mockReturnValue(control)
  let command: CommandDefinition | undefined
  const ctx = new Context()
  ctx.provide('commands', { register(next: CommandDefinition) { command = next; return () => { command = undefined } } } as never)
  Provider.apply(ctx, Provider.Config({ mode: 'user-chrome' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options).toMatchObject({ exclusive: true, activation: 'command' })
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', '--autoConnect', '--channel', 'stable', '--categoryPerformance=false', '--categoryMemory=false', '--categoryEmulation=false'])
  await vi.waitFor(() => { expect(command?.name).toBe('browser') })

  // The real check reads this machine's Chrome profile; whichever way it answers, a refusal must not connect.
  const result = await command!.handler({ agent: {} as CommandInvocation['agent'], rawInput: '' } as CommandInvocation)
  if (result.kind === 'error') {
    expect(result.text).toBe(Provider.REMOTE_DEBUGGING_SETUP)
    expect(control.connect).not.toHaveBeenCalled()
  } else {
    expect(control.connect).toHaveBeenCalledOnce()
  }
})

it('locates each Chrome channel\'s user-data directory per platform', () => {
  expect(Provider.chromeUserDataDir('stable', 'win32', { LOCALAPPDATA: 'L' })).toBe(join('L', 'Google', 'Chrome', 'User Data'))
  expect(Provider.chromeUserDataDir('canary', 'win32', { LOCALAPPDATA: 'L' })).toBe(join('L', 'Google', 'Chrome SxS', 'User Data'))
  expect(Provider.chromeUserDataDir('beta', 'darwin')).toMatch(/Library[\\/]Application Support[\\/]Google[\\/]Chrome Beta$/u)
  expect(Provider.chromeUserDataDir('dev', 'linux')).toMatch(/\.config[\\/]google-chrome-unstable$/u)
})

it('accepts remote debugging only when DevToolsActivePort names a listening port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chrome-profile-'))
  const server = createServer()
  try {
    expect(await Provider.checkRemoteDebugging(dir)).toBe(Provider.REMOTE_DEBUGGING_SETUP)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as { port: number }
    await writeFile(join(dir, 'DevToolsActivePort'), `${String(port)}\n/devtools/browser/fixture\n`)
    expect(await Provider.checkRemoteDebugging(dir)).toBeUndefined()
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
    // A closed Chrome leaves its port file behind.
    expect(await Provider.checkRemoteDebugging(dir)).toBe(Provider.REMOTE_DEBUGGING_SETUP)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
