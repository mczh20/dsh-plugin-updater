/**
 * Where an installed package came from, and what other versions of it exist.
 *
 * An update only needs a newer version; a *version picker* needs the whole history,
 * and the history lives in a different place depending on how the plugin was
 * installed. Two sources are supported, matching what the page's own installer and
 * `dsh plugin add` accept:
 *
 * - **registry** — one packument request answers every published version together
 *   with each version's own `peerDependencies`, so the whole table costs one call.
 * - **github** — tags when the repository has them, commits when it does not, since
 *   a repository with no releases still has installable revisions. Listing is one
 *   request; reading each revision's manifest would cost one request per row against
 *   a 60/hour anonymous limit, so that column is left empty instead (user decision).
 *
 * A `link:` or `file:` dependency has no history to list at all and is reported as
 * such rather than guessed at.
 * @module dsh-plugin-updater/lib/versions
 */

/** A dependency string that points at a git repository rather than a registry. */
const GIT_SPEC = /^(?:github|gitlab|bitbucket|gist):|^git\+|^git@|^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i

/** A dependency string that points at a location on disk. */
const LOCAL_SPEC = /^(?:link|file|workspace|portal|patch):/i

/** The one source kind that has no version history. */
export const SOURCE = { registry: 'registry', github: 'github', local: 'local' }

/**
 * Which source an installed package came from.
 * @param dependency - the profile manifest's dependency string for the package.
 * @returns the source kind.
 */
export function sourceOf(dependency) {
  if (typeof dependency !== 'string') return SOURCE.registry
  const spec = dependency.trim()
  if (LOCAL_SPEC.test(spec)) return SOURCE.local
  if (GIT_SPEC.test(spec) && !/\.(?:tgz|tar\.gz)(?:#.*)?$/i.test(spec)) return SOURCE.github
  return SOURCE.registry
}

/**
 * The `owner/repo` a git dependency names.
 *
 * Only the repository the package was installed from is ever queried: accepting a
 * repository from the browser would turn the updater into an arbitrary-code installer
 * for any public repository.
 * @param dependency - the profile manifest's dependency string.
 * @returns the `owner/repo` slug, or undefined when it cannot be read.
 */
export function repofromSpec(dependency) {
  if (typeof dependency !== 'string') return undefined
  const spec = dependency.trim().replace(/^github:/i, 'https://github.com/').replace(/^git\+/i, '')
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i.exec(spec)
  if (ssh !== null) return `${ssh[2]}/${ssh[3]}`
  try {
    const url = new URL(spec)
    const parts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
    if (parts.length < 2) return undefined
    return `${parts[0]}/${parts[1]}`
  } catch {
    return undefined
  }
}

/**
 * The commit a git dependency is pinned to, as the lockfile records it.
 * @param lockedVersion - the lockfile's `version` for that dependency.
 * @returns the commit hash, or undefined when the lock holds none.
 */
export function lockedCommit(lockedVersion) {
  if (typeof lockedVersion !== 'string') return undefined
  const at = lockedVersion.indexOf('#')
  if (at === -1) return undefined
  const commit = lockedVersion.slice(at + 1).trim()
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : undefined
}

/**
 * The DSH range a package version declares compatibility with.
 *
 * A plugin may state it through `peerDependencies['@deepseek-ai/dsh']` (the modern
 * form), through a top-level `engines.dsh`, or through the `dsh.engines.dsh` carrier
 * the official compatibility check reads. All three are read, in that order, because
 * the ecosystem is mid-migration between them.
 * @param manifest - one version's manifest from a packument.
 * @returns the declared range, or undefined when the version declares none.
 */
export function dshRangeOf(manifest) {
  if (manifest === undefined || manifest === null || typeof manifest !== 'object') return undefined
  const peer = manifest.peerDependencies
  if (peer !== undefined && peer !== null && typeof peer === 'object') {
    const value = peer['@deepseek-ai/dsh']
    if (typeof value === 'string' && value !== '') return value
  }
  const engines = manifest.engines
  if (engines !== undefined && engines !== null && typeof engines === 'object') {
    const value = engines.dsh
    if (typeof value === 'string' && value !== '') return value
  }
  const dsh = manifest.dsh
  if (dsh !== undefined && dsh !== null && typeof dsh === 'object') {
    const nested = dsh.engines
    if (nested !== undefined && nested !== null && typeof nested === 'object') {
      const value = nested.dsh
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

/**
 * Turn a packument into the rows a version table shows.
 *
 * The packument is asked for in its abbreviated form, which still carries each
 * version's `peerDependencies` but omits most other metadata — enough for this table
 * and far smaller than a full document.
 * @param packument - the parsed registry answer.
 * @param current - the version installed now.
 * @param order - how to sort: newest first.
 * @returns one row per published version, newest first.
 */
export function registryVersions(packument, current, order) {
  const versions = packument?.versions
  if (versions === undefined || versions === null || typeof versions !== 'object') return []
  const latest = typeof packument?.['dist-tags']?.latest === 'string' ? packument['dist-tags'].latest : undefined
  const rows = []
  for (const [version, manifest] of Object.entries(versions)) {
    if (typeof version !== 'string' || version === '') continue
    rows.push({
      version,
      ref: version,
      ...(dshRangeOf(manifest) === undefined ? {} : { dshRange: dshRangeOf(manifest) }),
      ...(latest === version ? { latest: true } : {}),
      ...(current === version ? { isCurrent: true } : {}),
      ...(typeof manifest?.deprecated === 'string' ? { deprecated: manifest.deprecated } : {}),
    })
  }
  rows.sort((a, b) => (order ?? defaultOrder)(b.version, a.version))
  return rows
}

/**
 * Compare two versions for listing order, tolerating values that are not semver.
 * @param a - left version.
 * @param b - right version.
 * @returns negative when a precedes b.
 */
function defaultOrder(a, b) {
  const split = (value) => String(value).split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l - r
      continue
    }
    const ls = String(l)
    const rs = String(r)
    if (ls !== rs) return ls < rs ? -1 : 1
  }
  return 0
}

/**
 * Turn GitHub's tag and commit lists into table rows.
 *
 * Tags carry the released name; a commit list is the fallback for a repository that
 * never tagged anything, and each row is then identified by its short hash. Neither
 * answer states a DSH compatibility range, and reading one per row would cost a
 * request per row against an anonymous limit of 60 per hour, so the column stays
 * empty by design.
 * @param input - the tag list, the commit list, and the commit installed now.
 * @returns one row per revision, newest first.
 */
export function githubVersions(input) {
  const { tags = [], commits = [], currentRef, currentVersion } = input
  const rows = []
  if (tags.length > 0) {
    for (const tag of tags) {
      const name = typeof tag?.name === 'string' ? tag.name : undefined
      if (name === undefined || name === '') continue
      const sha = typeof tag?.commit?.sha === 'string' ? tag.commit.sha : undefined
      rows.push({
        version: name,
        ref: sha ?? name,
        ...(currentRef !== undefined && sha === currentRef ? { isCurrent: true } : {}),
        ...(currentVersion !== undefined && (name === currentVersion || name === `v${currentVersion}`) ? { versionMatches: true } : {}),
      })
    }
    return rows
  }
  for (const commit of commits) {
    const sha = typeof commit?.sha === 'string' ? commit.sha : undefined
    if (sha === undefined) continue
    const short = sha.slice(0, 7)
    const message = typeof commit?.commit?.message === 'string' ? commit.commit.message.split('\n')[0] : ''
    rows.push({
      version: short,
      ref: sha,
      subject: message,
      ...(typeof commit?.commit?.author?.date === 'string' ? { publishedAt: commit.commit.author.date } : {}),
      ...(currentRef !== undefined && sha === currentRef ? { isCurrent: true } : {}),
    })
  }
  return rows
}
