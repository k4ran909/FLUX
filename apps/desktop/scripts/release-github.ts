/**
 * Build the next unsigned Windows installer and publish it as the latest GitHub release, the feed
 * `DSH_DESKTOP_UPDATE_FEED_URL` points installed applications at.
 *
 * Each run numbers a build version `<product>.<YYYYMMDD>.<n>` after the releases already on GitHub,
 * packages it, renames the installer to `FLUX-<version>-setup.exe` with the update metadata and
 * blockmap following it, and creates release `v<version>` carrying exactly those three files.
 * Requires an authenticated `gh` CLI.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_UPDATE_FEED_URL_ENV, resolveDesktopUnsignedUpdateFeed } from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const RELEASED_NAME = (version: string): string => `FLUX-${version}-setup.exe`

/**
 * Read `owner/name` from a GitHub latest-release download feed.
 * @param feedUrl - Feed URL from the packaging environment.
 * @returns The repository the feed serves.
 */
export function githubRepositoryOfFeed(feedUrl: string): string {
  const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/$/u.exec(feedUrl)?.[1]
  if (repository === undefined) {
    throw new Error(`desktop release: ${DESKTOP_UPDATE_FEED_URL_ENV} must be https://github.com/<owner>/<repo>/releases/latest/download/`)
  }
  return repository
}

/**
 * Number the next build after the releases already published for this product version and day.
 * @param productVersion - Version the Desktop manifest declares.
 * @param date - Build date as `YYYYMMDD`.
 * @param tags - Existing release tags.
 * @returns The next build version.
 */
export function nextBuildVersion(productVersion: string, date: string, tags: readonly string[]): string {
  const prefix = `v${productVersion}.${date}.`
  const taken = tags.filter(tag => tag.startsWith(prefix)).map(tag => Number(tag.slice(prefix.length))).filter(Number.isSafeInteger)
  return `${productVersion}.${date}.${String(Math.max(0, ...taken) + 1)}`
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function main(): void {
  const { values } = parseArgs({ options: { notes: { type: 'string' } }, args: process.argv.slice(2).filter(arg => arg !== '--') })
  const environment = loadDesktopPackageEnvironment('win32', process.env, APP_ROOT, { unsigned: true })
  const feed = resolveDesktopUnsignedUpdateFeed(environment)
  if (feed === undefined) throw new Error(`desktop release: set ${DESKTOP_UPDATE_FEED_URL_ENV} in apps/desktop/.env.windows`)
  const repository = githubRepositoryOfFeed(feed.publicUrl)

  const productVersion = (JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version
  const tags = (JSON.parse(run('gh', ['release', 'list', '--repo', repository, '--limit', '1000', '--json', 'tagName'])) as { tagName: string }[])
    .map(release => release.tagName)
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const version = nextBuildVersion(productVersion, date, tags)
  console.info(`desktop release: building ${version} for ${repository}`)

  execFileSync('pnpm', ['run', 'package:desktop:win:x64:unsigned', '--build-version', version],
    { cwd: REPOSITORY_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })

  const directory = desktopTargetBuildPaths('win-x64').unsignedArtifacts
  const built = `deepseek-harness-${version}-win-x64-unsigned.exe`
  const released = RELEASED_NAME(version)
  const metadataPath = join(directory, `${feed.channel}.yml`)
  for (const file of [built, `${built}.blockmap`, `${feed.channel}.yml`]) {
    if (!existsSync(join(directory, file))) throw new Error(`desktop release: packaging did not write ${file}`)
  }
  const metadata = readFileSync(metadataPath, 'utf8')
  if (!metadata.includes(`version: ${version}\n`)) throw new Error(`desktop release: ${feed.channel}.yml does not describe ${version}`)
  // The updater downloads `files[].url` and `<url>.blockmap` relative to the feed, so all three move together.
  writeFileSync(metadataPath, metadata.replaceAll(built, released))
  renameSync(join(directory, built), join(directory, released))
  renameSync(join(directory, `${built}.blockmap`), join(directory, `${released}.blockmap`))

  const notes = values.notes ?? [
    `Windows x64 installer for FLUX ${version}.`,
    '',
    `Installed copies update automatically. For a new install, download \`${released}\` and run it.`,
    'The installer is not code-signed, so Windows SmartScreen will warn: choose **More info → Run anyway**.',
  ].join('\n')
  run('gh', ['release', 'create', `v${version}`, '--repo', repository, '--latest', '--title', `FLUX ${version}`, '--notes', notes,
    join(directory, released), join(directory, `${released}.blockmap`), metadataPath])
  console.info(`desktop release: published https://github.com/${repository}/releases/tag/v${version}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main()
