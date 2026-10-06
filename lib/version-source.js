/**
 * Reading a package's version history from wherever it came from.
 *
 * Every network call the updater makes on the version picker's behalf lives here, so
 * the engine stays about decisions and the client stays about rendering. The two
 * lookups differ in cost and in what they can answer:
 *
 * - A registry answers every version plus each version's compatibility range in one
 *   abbreviated packument, so the table's "works with DSH" column is free.
 * - GitHub answers its tags or, failing that, its commits. Neither carries a
 *   compatibility range, and asking per row would spend one request per row against
 *   an anonymous limit of 60 per hour, so that column stays empty there.
 *
 * The registry asked is the profile's own first registry, the same one an install
 * would use, so a private or mirrored setup resolves the same versions either way.
 * @module dsh-plugin-updater/lib/version-source
 */

import { registryPlan } from './policy.js'
import { ghRequest } from './github.js'

/** How long one registry or GitHub request is given. */
const LOOKUP_TIMEOUT_MS = 15_000

/** How many commit rows a repository without tags contributes. */
const COMMIT_PAGE = 60

/**
 * Ask a registry for one package's abbreviated packument.
 *
 * The abbreviated content type is requested because it is the same document npm and
 * pnpm fetch for an install, and it still carries every version's `peerDependencies`
 * — which is the only per-version metadata this feature needs.
 * @param registries - the answer from `pluginManager.registries()`.
 * @param name - the package name.
 * @param signal - ends the lookup early.
 * @returns the parsed packument and the registry that answered.
 */
export async function fetchPackument(registries, name, signal) {
  const plan = registryPlan(registries)
  let lastProblem = 'no-registry'
  for (const registry of plan) {
    const base = registry ?? 'https://registry.npmjs.org/'
    const url = `${base.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`
    let response
    try {
      response = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        signal: mergeSignals(signal, LOOKUP_TIMEOUT_MS),
      })
    } catch {
      lastProblem = 'network'
      continue
    }
    if (response.status === 404) {
      lastProblem = 'not-found'
      continue
    }
    if (!response.ok) {
      lastProblem = 'lookup-failed'
      continue
    }
    try {
      return { packument: await response.json(), registry: base }
    } catch {
      lastProblem = 'unreadable-answer'
      continue
    }
  }
  return { problem: lastProblem }
}

/**
 * Read one repository's tags, or its commits when it has none.
 * @param repo - the `owner/repo` slug.
 * @param signal - ends the lookup early.
 * @returns the tags, the commits, and any problem.
 */
export async function fetchGithubVersions(repo, signal) {
  const tags = await ghRequest(`/repos/${repo}/tags?per_page=${String(COMMIT_PAGE)}`, signal)
  if (tags.ok && Array.isArray(tags.body) && tags.body.length > 0) {
    return { tags: tags.body, commits: [] }
  }
  // A repository with no tags still has installable revisions; list its commits so
  // the picker can offer them rather than showing an empty table.
  const commits = await ghRequest(`/repos/${repo}/commits?per_page=${String(COMMIT_PAGE)}`, signal)
  if (commits.ok && Array.isArray(commits.body)) return { tags: [], commits: commits.body }
  if (!tags.ok && !commits.ok) return { problem: tags.problem ?? commits.problem ?? 'lookup-failed' }
  return { tags: [], commits: [] }
}

/**
 * Add an abort signal that also fires on a timer.
 *
 * `AbortSignal.any` is unavailable on older runtimes, and a lookup that never ends
 * would hold the version dialog open forever, so a timer is composed by hand.
 * @param signal - the caller's signal, if any.
 * @param ms - the time bound.
 * @returns a signal that aborts on either.
 */
function mergeSignals(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('lookup timed out')), ms)
  timer.unref?.()
  const relay = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  // The timer is released once the controller settles either way.
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}
