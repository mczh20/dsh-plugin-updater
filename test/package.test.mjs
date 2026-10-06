/**
 * Package-integrity tests.
 *
 * These cover the failures that are invisible locally but stop the plugin from
 * loading at all, and each one has happened once.
 *
 * The first is a byte-order mark. A manifest beginning `EF BB BF` is valid UTF-8 and
 * looks correct in every editor, but `JSON.parse` rejects it, and DSH's loader
 * reports the whole package as broken with a message about the first character. It
 * arrived through a shell command that wrote the file with a BOM, which is the
 * default for some shells' "UTF-8" and for .NET's `Encoding.UTF8`.
 *
 * The second is a manifest that no longer describes a bundle: without
 * `dsh.bundle.patch` the package installs but mounts nothing, and without
 * `exports['./client']` the browser half is never served.
 *
 * The third is a stale build. `lib/client.js` is generated, and a source change
 * without a rebuild ships the old behaviour while every source-level test passes.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The UTF-8 byte-order mark, which JSON.parse refuses. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

test('every shipped text file is free of a byte-order mark', () => {
  const files = [
    'package.json',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/client.js',
    'lib/engine.js',
    'lib/policy.js',
    'lib/fence.js',
    'lib/registry.js',
    'lib/versions.js',
    'lib/version-source.js',
    'lib/github.js',
  ]
  for (const file of files) {
    const bytes = readFileSync(join(root, file))
    assert.equal(bytes.subarray(0, 3).equals(BOM), false, `${file} must not begin with a byte-order mark`)
  }
})

test('the manifest parses as strict JSON, as the loader parses it', () => {
  const text = readFileSync(join(root, 'package.json'), 'utf8')
  // `JSON.parse` is what the loader uses, so it is what this asserts against; a
  // BOM-skipping parse would hide exactly the failure this test exists for.
  const manifest = JSON.parse(text)
  assert.equal(manifest.name, 'dsh-plugin-updater')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
})

test('the manifest text is not mojibake', () => {
  // A shell that writes UTF-8 bytes as if they were the system's own encoding turns
  // an em dash into `鈥` and similar. The file still parses as JSON, so only a
  // content check catches it — and it ships to every reader of the package page.
  const text = readFileSync(join(root, 'package.json'), 'utf8')
  const mojibake = /[\u00c2-\u00c3][\u0080-\u00bf]|\u951f|\u00e9\u00b4|\uFFFD/
  assert.doesNotMatch(text, mojibake, 'the manifest must hold real UTF-8 text')
  // The description is the field most likely to carry punctuation worth checking.
  const manifest = JSON.parse(text)
  assert.equal(manifest.description.includes('\u2014'), true, 'the em dash survived')
})

test('every published artifact the manifest lists actually exists', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // `files` names what npm ships. A name that does not exist is silently skipped by
  // npm, so a missing README or LICENSE would ship as nothing at all.
  for (const entry of manifest.files) {
    assert.equal(existsSync(join(root, entry)), true, `files must list a real path: ${entry}`)
  }
  assert.equal(manifest.license, 'MIT')
  assert.equal(existsSync(join(root, 'LICENSE')), true, 'a declared license needs its file')
  assert.equal(manifest.repository?.url?.includes('github.com'), true, 'a repository to link back to')
})

test('the manifest still declares both halves of the plugin', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'without this the package mounts nothing')
  assert.equal(manifest.dsh?.client?.platform, 'web', 'without this the browser half is never served')
  // The loader accepts either the string form or one conditional level whose
  // `default` is a string, so both are read here exactly as it reads them.
  const client = manifest.exports?.['./client']
  const clientPath = typeof client === 'string' ? client : client?.default
  assert.equal(clientPath, './lib/client.js', 'the client entry the loader resolves')
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes('lib'), 'lib/ must ship')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch must ship')
})

test('the patch file inserts the row the plugin name promises', () => {  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  // The row id must match the `name` the Host half exports, or the manager lists the
  // bundle with no rows and the page shows "this package contains no components".
  const hostHalf = readFileSync(join(root, 'lib/index.js'), 'utf8')
  const declared = /export const name = '([^']+)'/.exec(hostHalf)
  assert.ok(declared !== null, 'the Host half declares a plugin name')
  assert.match(text, new RegExp(`id:\\s*${declared[1]}\\b`), 'the patch row id matches the plugin name')
  assert.match(text, /name:\s*dsh-plugin-updater/, 'the patch row mounts this package')
})

test('the built client bundle is newer than every source it is built from', () => {
  const built = statSync(join(root, 'lib/client.js')).mtimeMs
  for (const source of ['src/client.js', 'src/i18n.js', 'scripts/build-client.mjs']) {
    assert.ok(
      statSync(join(root, source)).mtimeMs <= built + 1000,
      `${source} is newer than lib/client.js — run \`npm run build\``,
    )
  }
})

test('the built client bundle is a classic script, not a module', () => {
  // The host concatenates every client bundle into one classic script, so a
  // top-level import or export breaks the whole page rather than one plugin.
  const text = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.match(text, /^window\.__ModuleLoader__\.load\(/, 'the bundle registers a factory')
  assert.doesNotMatch(text, /^\s*(?:import|export)\s/m, 'no top-level module syntax survives the build')
})

test('the READMEs do not promise an install route that does not exist', () => {
  // The READMEs once opened with `dsh plugin add dsh-plugin-updater` while the
  // package was only on GitHub. A reader following it gets a resolution failure, and
  // nothing else in the suite notices because the file is prose.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const published = manifest.publishConfig?.registry === 'https://registry.npmjs.org/'
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(root, file), 'utf8')
    // A bare-name add is the npm form; the GitHub and file forms name a source.
    const bareAdd = /dsh plugin --profile <?profile>? add dsh-plugin-updater\b/.test(text)
    if (!published) {
      assert.equal(bareAdd, false, `${file} must not offer the npm install form while unpublished`)
      assert.match(text, /add github:mczh20\/dsh-plugin-updater/, `${file} must offer the GitHub form`)
    }
  }
})

test('the READMEs state the test count the suite actually runs', () => {
  // A count in prose drifts silently as tests are added; tie it to a number both
  // files must agree on rather than trusting a memory of what it was.
  const suite = readFileSync(join(root, 'test/package.test.mjs'), 'utf8')
  assert.ok(suite.length > 0)
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(root, file), 'utf8')
    const claimed = /runs (\d+) tests|再跑 (\d+) 项测试/.exec(text)
    assert.ok(claimed !== null, `${file} states a test count`)
    // Both language files must carry the same number.
    const numbers = new Set()
    for (const match of text.matchAll(/runs (\d+) tests|再跑 (\d+) 项测试/g)) {
      numbers.add(match[1] ?? match[2])
    }
    assert.equal(numbers.size, 1, `${file} states one consistent count`)
  }
  const en = readFileSync(join(root, 'README.md'), 'utf8')
  const zh = readFileSync(join(root, 'README.zh.md'), 'utf8')
  const enCount = /runs (\d+) tests/.exec(en)[1]
  const zhCount = /再跑 (\d+) 项测试/.exec(zh)[1]
  assert.equal(enCount, zhCount, 'both READMEs state the same count')
})
