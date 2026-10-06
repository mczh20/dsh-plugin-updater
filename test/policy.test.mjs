/**
 * Unit tests for the updater's policy and fence — the two pieces whose mistakes
 * are silent: a wrong version comparison shows the wrong button, and a loose fence
 * lets a web page drive local package installation.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  BUILTIN_PROFILE_BUNDLES,
  OUTCOME,
  SKIP,
  checkResult,
  compareVersions,
  isPackageName,
  isReleaseVersion,
  refuseUpdate,
  registryPlan,
  skipReason,
} from '../lib/policy.js'
import { isLoopbackAddress, isLoopbackHost, isSameOriginLoopback, isTrustedRequest } from '../lib/fence.js'
import { parseVersion } from '../lib/registry.js'

test('compareVersions orders releases by semver precedence', () => {
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0)
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0, 'numeric, not lexical')
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0)
  assert.ok(compareVersions('1.0.0', '1.0.0+build.7') === 0, 'build metadata is ignored')
})

test('compareVersions orders prereleases the way the registry does', () => {
  // The whole reason this function exists: DSH plugins ship release candidates,
  // and the user asked for rc versions to count as real updates.
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0, 'rc.2 precedes rc.10')
  assert.ok(compareVersions('0.2.0-rc.9', '0.2.0') < 0, 'a prerelease precedes its release')
  assert.ok(compareVersions('0.2.0-alpha.1', '0.2.0-rc.1') < 0, 'alpha precedes rc')
  assert.ok(compareVersions('0.2.0-rc.1', '0.2.0-rc.1.1') < 0, 'a longer prerelease run wins')
  assert.ok(compareVersions('1.1.25', '1.1.28') < 0)
})

test('skipReason refuses what has no registry version to compare', () => {
  assert.equal(skipReason({ name: 'x', installed: true, version: '1.0.0' }, '^1.0.0'), undefined)
  assert.equal(
    skipReason({ name: 'x', installed: true, version: '1.0.0' }, 'link:C:/somewhere'),
    SKIP.notRegistry,
    'a link: dependency has no registry version',
  )
  assert.equal(skipReason({ name: 'x', installed: true, version: '1.0.0' }, 'workspace:*'), SKIP.notRegistry)
  assert.equal(skipReason({ name: 'x', installed: true, version: '1.0.0' }, 'file:../x'), SKIP.notRegistry)
  assert.equal(skipReason({ name: 'x', installed: true, version: '1.0.0' }, 'github:o/r'), SKIP.notRegistry)
  assert.equal(
    skipReason({ name: '@deepseek-ai/dsh-base', installed: true, version: '0.2.0-rc.2' }, '0.2.0-rc.2'),
    SKIP.builtin,
    'a built-in follows the DSH release',
  )
  assert.equal(
    skipReason({ name: 'opt', installed: false, optional: true, version: '1.0.0' }, undefined),
    SKIP.optional,
    'an optional bundle follows the DSH release',
  )
  assert.equal(skipReason({ name: 'x', installed: true }, undefined), SKIP.noVersion)
  assert.equal(skipReason({ name: 'x', installed: true, version: 'not-a-version' }, undefined), SKIP.notSemver)
})

test('every official built-in is excluded', () => {
  for (const builtin of BUILTIN_PROFILE_BUNDLES) {
    assert.equal(skipReason({ name: builtin, installed: true, version: '0.2.0-rc.2' }, '0.2.0-rc.2'), SKIP.builtin)
  }
})

test('checkResult reports an update only when the registry is genuinely ahead', () => {
  const bundle = { name: 'dsh-plugin-smooth-stream', installed: true, version: '1.2.0', enabled: true }
  assert.deepEqual(checkResult(bundle, undefined, '1.3.0', undefined, 'https://r/'), {
    name: 'dsh-plugin-smooth-stream',
    installed: '1.2.0',
    enabled: true,
    outcome: OUTCOME.update,
    latest: '1.3.0',
    registry: 'https://r/',
  })
  assert.equal(checkResult(bundle, undefined, '1.2.0', undefined, 'https://r/').outcome, OUTCOME.current)
  assert.equal(checkResult(bundle, undefined, '1.0.0', undefined, 'https://r/').outcome, OUTCOME.current)
  assert.equal(checkResult(bundle, undefined, undefined, 'network', undefined).outcome, OUTCOME.unknown)
  assert.equal(checkResult(bundle, SKIP.builtin).outcome, OUTCOME.skip)
})

test('registryPlan asks the resolved registry first, then each fallback once', () => {
  const plan = registryPlan({
    registry: 'https://configured/',
    resolved: 'https://resolved/',
    fallbackRegistries: ['https://mirror/', 'https://resolved/'],
  })
  assert.deepEqual(plan, ['https://resolved/', 'https://mirror/'])
  assert.deepEqual(registryPlan({}), [null], 'pnpm\u2019s own registry is the last resort')
  assert.deepEqual(registryPlan({ registry: 'https://a/', fallbackRegistries: ['https://a/'] }), ['https://a/'])
})

test('isPackageName accepts registry names and refuses anything shell-shaped', () => {
  assert.ok(isPackageName('dsh-plugin-smooth-stream'))
  assert.ok(isPackageName('@michengai/dsh-codex-ui'))
  for (const bad of ['', '--force', 'a b', 'a;rm -rf /', 'a/b/c', 'a$(x)', 'A-Upper', 'https://x/', null, 42]) {
    assert.equal(isPackageName(bad), false, `must refuse ${String(bad)}`)
  }
})

test('isReleaseVersion accepts releases and prereleases but no range syntax', () => {
  assert.ok(isReleaseVersion('1.2.0'))
  assert.ok(isReleaseVersion('0.2.0-rc.2'))
  assert.ok(isReleaseVersion('1.0.0-rc.1+build'))
  for (const bad of ['^1.0.0', 'latest', '1.0', '>=1.0.0', '1.0.0 || 2.0.0', 'file:../x', '', null]) {
    assert.equal(isReleaseVersion(bad), false, `must refuse ${String(bad)}`)
  }
})

test('refuseUpdate re-validates the whole request against live state', () => {
  const bundles = [{ name: 'p', installed: true, version: '1.0.0' }]
  const dependencies = { p: '^1.0.0' }
  assert.equal(refuseUpdate('p', '1.1.0', bundles, dependencies, '1.1.0'), undefined)
  assert.equal(refuseUpdate('p', '1.1.0', bundles, dependencies, '1.2.0'), undefined, 'older than latest is fine')
  assert.equal(refuseUpdate('p', '2.0.0', bundles, dependencies, '1.1.0'), 'ahead-of-registry')
  assert.equal(refuseUpdate('p', '1.0.0', bundles, dependencies, '1.1.0'), 'not-newer')
  assert.equal(refuseUpdate('p', '0.9.0', bundles, dependencies, '1.1.0'), 'not-newer')
  assert.equal(refuseUpdate('other', '1.1.0', bundles, dependencies, '1.1.0'), 'unknown-package')
  assert.equal(refuseUpdate('p', '^1.0.0', bundles, dependencies, '1.1.0'), 'invalid-version')
  assert.equal(refuseUpdate('--force', '1.1.0', bundles, dependencies, '1.1.0'), 'invalid-name')
  assert.equal(
    refuseUpdate('p', '1.1.0', [{ name: 'p', installed: true, version: '1.0.0' }], { p: 'link:../p' }, '1.1.0'),
    SKIP.notRegistry,
    'a link dependency cannot be updated even when the caller names it',
  )
})

test('the loopback address fence covers the whole loopback range and nothing else', () => {
  assert.ok(isLoopbackAddress('127.0.0.1'))
  assert.ok(isLoopbackAddress('127.9.9.9'))
  assert.ok(isLoopbackAddress('::1'))
  assert.ok(isLoopbackAddress('::ffff:127.0.0.1'))
  for (const bad of ['10.0.0.1', '192.168.1.5', '0.0.0.0', '::', '8.8.8.8', '127.0.0.256', '', undefined]) {
    assert.equal(isLoopbackAddress(bad), false, `must refuse ${String(bad)}`)
  }
})

test('the host fence accepts local authorities only', () => {
  assert.ok(isLoopbackHost('127.0.0.1:19387'))
  assert.ok(isLoopbackHost('localhost:19387'))
  assert.ok(isLoopbackHost('[::1]:19387'))
  for (const bad of ['example.com', 'evil.localhost.com', '10.0.0.1:80', '', undefined]) {
    assert.equal(isLoopbackHost(bad), false, `must refuse ${String(bad)}`)
  }
})

test('the origin fence refuses a page this server could not have served', () => {
  assert.ok(isSameOriginLoopback({ headers: {} }), 'a non-browser client carries no origin')
  assert.ok(isSameOriginLoopback({ headers: { origin: 'http://127.0.0.1:19387' } }))
  assert.ok(isSameOriginLoopback({ headers: { 'sec-fetch-site': 'same-origin' } }))
  assert.equal(isSameOriginLoopback({ headers: { origin: 'http://evil.example' } }), false)
  assert.equal(isSameOriginLoopback({ headers: { origin: 'https://evil.localhost.com' } }), false)
  assert.equal(isSameOriginLoopback({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
})

test('the whole fence needs every layer', () => {
  const good = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' } }
  assert.ok(isTrustedRequest(good))
  assert.equal(isTrustedRequest({ ...good, socket: { remoteAddress: '192.168.1.9' } }), false, 'a LAN peer is not the operator')
  assert.equal(isTrustedRequest({ ...good, headers: { host: 'example.com' } }), false, 'a DNS-rebound host is not the operator')
  assert.equal(
    isTrustedRequest({ ...good, headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }),
    false,
    'a hostile page driving the user\u2019s browser is not the operator',
  )
})

test('parseVersion reads what pnpm view actually prints', () => {
  assert.equal(parseVersion('"1.3.0"'), '1.3.0')
  assert.equal(parseVersion('["1.2.0","1.3.0"]'), '1.3.0')
  assert.equal(parseVersion('{"version":"1.3.0"}'), '1.3.0')
  assert.equal(parseVersion('  1.3.0  '), undefined, 'bare text is not JSON')
  assert.equal(parseVersion(''), undefined)
  assert.equal(parseVersion('null'), undefined)
})
