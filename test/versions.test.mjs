/**
 * Tests for source detection and version-history shaping.
 *
 * These are the two places a mistake is quiet. Detecting the wrong source sends the
 * picker to the wrong place and shows an empty table; shaping a row wrongly sends a
 * value to pnpm that was never in the list. Both are pure functions, so both are
 * pinned here.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { SOURCE, dshRangeOf, githubVersions, lockedCommit, registryVersions, repofromSpec, sourceOf } from '../lib/versions.js'
import { repoOf } from '../lib/github.js'

test('sourceOf tells a registry install from a git one and from a local path', () => {
  assert.equal(sourceOf('^1.2.0'), SOURCE.registry)
  assert.equal(sourceOf('1.2.0'), SOURCE.registry)
  assert.equal(sourceOf('latest'), SOURCE.registry)
  assert.equal(sourceOf(undefined), SOURCE.registry, 'an absent dependency is treated as a registry name')

  assert.equal(sourceOf('github:Loliyer520/dsh-codex-ui'), SOURCE.github)
  assert.equal(sourceOf('git+https://github.com/Loliyer520/dsh-codex-ui.git'), SOURCE.github)
  assert.equal(sourceOf('git@github.com:Loliyer520/dsh-codex-ui.git'), SOURCE.github)
  assert.equal(sourceOf('https://github.com/Loliyer520/dsh-codex-ui'), SOURCE.github)

  assert.equal(sourceOf('link:C:/Users/x/pkg'), SOURCE.local)
  assert.equal(sourceOf('file:../pkg'), SOURCE.local)
  assert.equal(sourceOf('workspace:*'), SOURCE.local)
})

test('a tarball URL is not mistaken for a git repository', () => {
  assert.equal(sourceOf('https://example.com/pkg-1.0.0.tgz'), SOURCE.registry)
  assert.equal(sourceOf('https://example.com/pkg.tgz#abc'), SOURCE.registry)
})

test('repofromSpec reads the owner and repository from every git form', () => {
  assert.equal(repofromSpec('github:Loliyer520/dsh-codex-ui'), 'Loliyer520/dsh-codex-ui')
  assert.equal(repofromSpec('git+https://github.com/Loliyer520/dsh-codex-ui.git'), 'Loliyer520/dsh-codex-ui')
  assert.equal(repofromSpec('https://github.com/Loliyer520/dsh-codex-ui'), 'Loliyer520/dsh-codex-ui')
  assert.equal(repofromSpec('git@github.com:Loliyer520/dsh-codex-ui.git'), 'Loliyer520/dsh-codex-ui')
  assert.equal(repofromSpec('https://github.com/owner/repo#v1'), 'owner/repo')
  // A repository that is not a full owner/repo pair is not a repository.
  assert.equal(repofromSpec('github:justaname'), undefined)
  assert.equal(repofromSpec(undefined), undefined)
})

test('lockedCommit reads the revision pnpm recorded', () => {
  assert.equal(
    lockedCommit('git+https://github.com/Loliyer520/dsh-codex-ui.git#cab5b3bc0def633497489a1dfbfc9a9b103640b6'),
    'cab5b3bc0def633497489a1dfbfc9a9b103640b6',
  )
  assert.equal(lockedCommit('1.2.0'), undefined)
  assert.equal(lockedCommit('git+https://github.com/a/b.git#not-a-sha'), undefined)
  assert.equal(lockedCommit(undefined), undefined)
})

test('dshRangeOf reads all three places a plugin declares compatibility', () => {
  assert.equal(dshRangeOf({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.2 <0.3.0-0' } }), '>=0.2.0-rc.2 <0.3.0-0')
  assert.equal(dshRangeOf({ engines: { dsh: '>=0.1.5-rc.2 <0.1.6-0' } }), '>=0.1.5-rc.2 <0.1.6-0')
  assert.equal(dshRangeOf({ dsh: { engines: { dsh: '0.2.0-rc.2' } } }), '0.2.0-rc.2')
  // The peer field wins when several are present, matching the official check's order.
  assert.equal(
    dshRangeOf({ peerDependencies: { '@deepseek-ai/dsh': 'A' }, engines: { dsh: 'B' }, dsh: { engines: { dsh: 'C' } } }),
    'A',
  )
  assert.equal(dshRangeOf({}), undefined)
  assert.equal(dshRangeOf({ peerDependencies: { '@deepseek-ai/dsh': '' } }), undefined)
  assert.equal(dshRangeOf(undefined), undefined)
})

test('registryVersions lists every published version with its own range', () => {
  const packument = {
    'dist-tags': { latest: '1.3.0' },
    versions: {
      '1.2.0': { engines: { dsh: '>=0.1.5-rc.2 <0.1.6-0' } },
      '1.3.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.2 <0.3.0-0' } },
      '1.1.0': {},
    },
  }
  const rows = registryVersions(packument, '1.2.0')
  assert.deepEqual(
    rows.map((row) => row.version),
    ['1.3.0', '1.2.0', '1.1.0'],
    'newest first',
  )
  assert.equal(rows[0].latest, true)
  assert.equal(rows[0].dshRange, '>=0.2.0-rc.2 <0.3.0-0')
  assert.equal(rows[1].isCurrent, true, 'the installed version is marked')
  assert.equal(rows[1].dshRange, '>=0.1.5-rc.2 <0.1.6-0')
  assert.equal(rows[2].dshRange, undefined, 'a version that declares nothing carries no range')
  assert.equal(rows[2].latest, undefined)
})

test('registryVersions tolerates a malformed packument', () => {
  assert.deepEqual(registryVersions(undefined, '1.0.0'), [])
  assert.deepEqual(registryVersions({}, '1.0.0'), [])
  assert.deepEqual(registryVersions({ versions: null }, '1.0.0'), [])
})

test('githubVersions prefers tags and falls back to commits', () => {
  const tagged = githubVersions({
    tags: [
      { name: 'v1.2.0', commit: { sha: 'aaa1111' } },
      { name: 'v1.1.0', commit: { sha: 'bbb2222' } },
    ],
    commits: [{ sha: 'ignored' }],
    currentRef: 'bbb2222',
  })
  assert.deepEqual(
    tagged.map((row) => row.version),
    ['v1.2.0', 'v1.1.0'],
  )
  assert.equal(tagged[1].isCurrent, true, 'the installed revision is marked by sha')
  assert.equal(tagged[0].ref, 'aaa1111', 'the ref is the sha, which is what pnpm must take')

  // A repository with no tags still has installable revisions.
  const untagged = githubVersions({
    tags: [],
    commits: [
      { sha: 'cab5b3bc0def633497489a1dfbfc9a9b103640b6', commit: { message: 'Add settings menu', author: { date: '2026-10-03T15:12:17Z' } } },
      { sha: '12f53a84f770c4318bcf5a9bb8f9922a8778954b', commit: { message: 'Fix spacing' } },
    ],
    currentRef: 'cab5b3bc0def633497489a1dfbfc9a9b103640b6',
  })
  assert.deepEqual(
    untagged.map((row) => row.version),
    ['cab5b3b', '12f53a8'],
    'a commit row is named by its short hash',
  )
  assert.equal(untagged[0].isCurrent, true)
  assert.equal(untagged[0].subject, 'Add settings menu')
  assert.equal(untagged[0].ref, 'cab5b3bc0def633497489a1dfbfc9a9b103640b6', 'the full sha is what installs')
  assert.equal(untagged[0].dshRange, undefined, 'a commit states no compatibility range')
})

test('githubVersions tolerates missing fields', () => {
  assert.deepEqual(githubVersions({ tags: [{ name: '' }], commits: [] }), [])
  assert.deepEqual(githubVersions({ tags: [{ commit: {} }], commits: [] }), [])
  assert.deepEqual(githubVersions({ tags: [], commits: [{ commit: {} }] }), [])
})

test('repoOf accepts an install spec and refuses a bare name', () => {
  assert.equal(repoOf('github:owner/repo'), 'owner/repo')
  assert.equal(repoOf('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(repoOf('justaname'), undefined)
  assert.equal(repoOf(undefined), undefined)
})
