/**
 * Engine tests against a stub manager.
 *
 * `UpdateEngine` owns the one decision that is invisible until it goes wrong — what
 * an update does to a bundle's activation — plus the self-healing path an
 * interrupted install needs. Both are exercised here through the real `installBundle`
 * call, so the arguments the engine passes are asserted rather than assumed.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UpdateEngine, describeFailure } from '../lib/engine.js'

/**
 * Build a profile directory holding one installed bundle at a given version.
 * @param bundles - name → version on disk.
 * @returns the profile directory.
 */
async function profileWith(bundles) {
  const dir = await mkdtemp(join(tmpdir(), 'updater-engine-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test-profile', private: true, dependencies: {} }))
  for (const [name, version] of Object.entries(bundles)) {
    const packageDir = join(dir, 'node_modules', name)
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version }))
  }
  return dir
}

/**
 * A stub of the manager's service surface, recording what the engine asked for.
 * @param options - the bundle rows, the on-disk versions, and the registry latest.
 * @returns the stub and its recorded calls.
 */
function stubManager(options) {
  const calls = { installs: [], selections: [] }
  const manager = {
    profile: { dir: options.dir },
    calls,
    async listBundles() {
      return options.bundles
    },
    async registries() {
      return { registry: null, fallbackRegistries: [], resolved: 'https://registry.example/' }
    },
    async installBundle(spec, settings) {
      calls.installs.push({ spec, settings })
      if (options.onInstall !== undefined) return options.onInstall({ spec, settings, calls })
      return { bundle: spec.split('@')[0], target: spec, stage: 'enable' }
    },
    // The reload the engine performs after a successful install. `application` is
    // what the manager reports: `applied` with HMR, `restart-required` without.
    async setBundleEnabled(name, enabled) {
      calls.selections.push({ name, enabled })
      return {
        stage: 'enable',
        target: name,
        enabled,
        changed: false,
        application: options.application ?? 'applied',
        warnings: [],
      }
    },
  }
  return manager
}

/**
 * Make the engine read `latest` without touching a registry, and let the repair
 * path actually succeed.
 *
 * The engine asks the registry through `pnpm view` and repairs a missing package
 * through `pnpm add`. This writes a fake pnpm that answers `view` from a table and
 * performs `add` by materializing the package directory, so both paths run for real
 * instead of being stubbed out.
 * @param dir - the profile directory.
 * @param versions - package name → version the fake pnpm answers and installs.
 */
async function installFakePnpm(dir, versions) {
  const bin = join(dir, 'fake-pnpm')
  await mkdir(bin, { recursive: true })
  const script = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const known = ${JSON.stringify(versions)}
const dir = ${JSON.stringify(dir)}
const spec = args[1] ?? ''
const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('@')[0]
if (args[0] === 'view') {
  process.stdout.write(JSON.stringify(known[name] ?? null))
  process.exit(0)
}
if (args[0] === 'add') {
  const version = spec.includes('@', 1) ? spec.slice(spec.lastIndexOf('@') + 1) : (known[name] ?? '0.0.0')
  const target = join(dir, 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version }))
  process.exit(0)
}
process.exit(0)
`
  const file = join(bin, 'pnpm.mjs')
  await writeFile(file, script)
  return { command: process.execPath, args: [file] }
}

/** Build an engine whose registry lookup answers from a fixed table. */
async function engineFor(options) {
  const dir = options.dir
  const pnpm = await installFakePnpm(dir, options.versions)
  const manager = stubManager({ ...options, dir })
  manager.listBundles = async () => options.bundles
  const engine = new UpdateEngine(
    { ...manager, profile: { dir, packageManager: pnpm } },
    { warn: () => {} },
  )
  return { engine, calls: manager.calls }
}

test('an update leaves a disabled bundle disabled', async () => {
  // The bug this covers shipped once: an unconditional `enabled: true` switched on a
  // plugin the person had turned off, and it stayed on until they noticed.
  const dir = await profileWith({ 'dsh-plugin-off': '1.0.0' })
  const { engine, calls } = await engineFor({
    dir,
    versions: { 'dsh-plugin-off': '2.0.0' },
    bundles: [{ name: 'dsh-plugin-off', version: '1.0.0', installed: true, enabled: false }],
  })
  const result = await engine.update('dsh-plugin-off', '2.0.0')
  assert.equal(calls.installs.length, 1)
  assert.equal(calls.installs[0].settings.enabled, false, 'a disabled bundle must stay disabled')
  assert.equal(result.status, 'failed', 'the on-disk version never changed, so the update did not apply')
})

test('an update keeps an enabled bundle enabled and applies it live', async () => {
  const dir = await profileWith({ 'dsh-plugin-on': '2.0.0' })
  const { engine, calls } = await engineFor({
    dir,
    versions: { 'dsh-plugin-on': '2.0.0' },
    bundles: [{ name: 'dsh-plugin-on', version: '1.0.0', installed: true, enabled: true }],
  })
  const result = await engine.update('dsh-plugin-on', '2.0.0')
  assert.equal(calls.installs[0].settings.enabled, true, 'an enabled bundle stays enabled')
  // The reload is what makes the new bytes the running ones, and it
  // re-selects exactly the selection the bundle already had.
  assert.deepEqual(calls.selections, [{ name: 'dsh-plugin-on', enabled: true }])
  assert.equal(result.status, 'updated', 'a live profile needs no restart')
  assert.equal(result.changedOnRestart, undefined)
  assert.equal(result.from, '1.0.0')
  assert.equal(result.to, '2.0.0')
})

test('a profile without hot reload reports the restart it actually needs', async () => {
  const dir = await profileWith({ p: '2.0.0' })
  const { engine, calls } = await engineFor({
    dir,
    application: 'restart-required',
    versions: { p: '2.0.0' },
    bundles: [{ name: 'p', version: '1.0.0', installed: true, enabled: true }],
  })
  const result = await engine.update('p', '2.0.0')
  assert.equal(calls.installs.length, 1, 'the update still happened')
  assert.equal(result.status, 'restart-required')
  assert.equal(result.changedOnRestart, true)
})

test('a failing reload does not turn a successful update into a failure', async () => {
  const dir = await profileWith({ p: '2.0.0' })
  const pnpm = await installFakePnpm(dir, { p: '2.0.0' })
  const calls = { installs: [] }
  const engine = new UpdateEngine(
    {
      profile: { dir, packageManager: pnpm },
      async listBundles() {
        return [{ name: 'p', version: '1.0.0', installed: true, enabled: true }]
      },
      async registries() {
        return { registry: null, fallbackRegistries: [], resolved: 'https://registry.example/' }
      },
      async installBundle(spec, settings) {
        calls.installs.push({ spec, settings })
        return { bundle: 'p', stage: 'enable' }
      },
      async setBundleEnabled() {
        throw new Error('reload blew up')
      },
    },
    { warn: () => {} },
  )
  const result = await engine.update('p', '2.0.0')
  assert.equal(result.status, 'restart-required', 'the files are new; only the reload failed')
  assert.match(result.warning, /reload blew up/, 'and the reason is carried, not swallowed')
})

test('a disabled bundle is not re-enabled by the reload either', async () => {
  const dir = await profileWith({ off: '2.0.0' })
  const { engine, calls } = await engineFor({
    dir,
    versions: { off: '2.0.0' },
    bundles: [{ name: 'off', version: '1.0.0', installed: true, enabled: false }],
  })
  await engine.update('off', '2.0.0')
  assert.equal(calls.installs[0].settings.enabled, false)
  assert.deepEqual(calls.selections, [{ name: 'off', enabled: false }], 'the reload preserves the off selection')
})

test('an update never touches a built-in or an uninstalled package', async () => {
  const dir = await profileWith({})
  const { engine, calls } = await engineFor({
    dir,
    versions: { '@deepseek-ai/dsh-base': '9.9.9' },
    bundles: [{ name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', installed: true, enabled: true }],
  })
  const result = await engine.update('@deepseek-ai/dsh-base', '9.9.9')
  assert.equal(calls.installs.length, 0, 'no install was attempted for a built-in')
  assert.equal(result.status, 'refused')
})

test('an update refuses a version the registry does not have', async () => {
  const dir = await profileWith({ p: '1.0.0' })
  const { engine, calls } = await engineFor({
    dir,
    versions: { p: '1.1.0' },
    bundles: [{ name: 'p', version: '1.0.0', installed: true, enabled: true }],
  })
  const result = await engine.update('p', '5.0.0')
  assert.equal(calls.installs.length, 0, 'a version ahead of the registry is refused before pnpm runs')
  assert.equal(result.failure.code, 'ahead-of-registry')
})

test('a missing package is repaired to its previous version', async () => {
  // An interrupted download removes the top-level link while the manifest still
  // names the package, and the manager's own `--frozen-lockfile` recovery does not
  // put it back. The engine must.
  const dir = await profileWith({ p: '1.0.0' })
  const pnpm = await installFakePnpm(dir, { p: '2.0.0' })
  const calls = { installs: [] }
  const manager = {
    profile: { dir, packageManager: pnpm },
    async listBundles() {
      return [{ name: 'p', version: '1.0.0', installed: true, enabled: true }]
    },
    async registries() {
      return { registry: null, fallbackRegistries: [], resolved: 'https://registry.example/' }
    },
    async installBundle(spec, settings) {
      calls.installs.push({ spec, settings })
      // Simulate the interrupted install: the package is gone from disk.
      const { rm } = await import('node:fs/promises')
      await rm(join(dir, 'node_modules', 'p'), { recursive: true, force: true })
      throw Object.assign(new Error('network failure'), { code: 'install-failed' })
    },
  }
  const engine = new UpdateEngine(manager, { warn: () => {} })
  const result = await engine.update('p', '2.0.0')
  assert.equal(result.status, 'failed')
  assert.equal(result.repaired?.status, 'restored', 'the engine restored the previous version')
  assert.equal(result.repaired.version, '1.0.0')
})

test('describeFailure reads the manager\u2019s own error shapes', () => {
  assert.deepEqual(
    describeFailure(Object.assign(new Error('x'), { code: 'incompatible-version', incompatible: [{ name: 'p' }] })),
    { code: 'incompatible-version', incompatible: [{ name: 'p' }] },
  )
  const blocked = describeFailure(Object.assign(new Error('blocked'), { code: 'build-blocked', pendingBuilds: ['a'] }))
  assert.equal(blocked.code, 'build-blocked')
  assert.deepEqual(blocked.pendingBuilds, ['a'])
  const plain = describeFailure(new Error('boom'))
  assert.equal(plain.code, 'install-failed')
  assert.match(plain.diagnostic, /boom/)
})

test('one update at a time', async () => {
  const dir = await profileWith({ p: '2.0.0' })
  const { engine } = await engineFor({
    dir,
    versions: { p: '2.0.0' },
    bundles: [{ name: 'p', version: '1.0.0', installed: true, enabled: true }],
  })
  const first = engine.update('p', '2.0.0')
  const second = await engine.update('p', '2.0.0')
  assert.equal(second.status, 'busy', 'a second update is refused while the first runs')
  await first
  assert.equal(engine.busy, false)
  assert.ok(engine.state().lastRun !== null, 'the finished run is remembered')
})
