/**
 * The small slice of GitHub's REST API this feature needs.
 *
 * Two facts shape it. GitHub's anonymous limit is 60 requests per hour *per IP*, and
 * on a shared or carrier-natted address that budget is already partly spent before
 * the user asks for anything — so a refusal is reported as its own problem rather
 * than being mistaken for a missing repository. And a public repository needs no
 * credential at all, so none is required: a `GITHUB_TOKEN`-style credential is used
 * when the caller supplies one, purely to raise the limit.
 * @module dsh-plugin-updater/lib/github
 */

/** GitHub's REST base. */
const API = 'https://api.github.com'

/** The version picker reads one page of tags and one of commits. */
const TIMEOUT_MS = 15_000

/**
 * Ask GitHub for one path.
 * @param path - the API path, beginning with `/`.
 * @param signal - the caller's abort signal.
 * @param token - an optional token, raising the anonymous rate limit.
 * @returns the parsed body, or a problem naming what went wrong.
 */
export async function ghRequest(path, signal, token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('github lookup timed out')), TIMEOUT_MS)
  timer.unref?.()
  const relay = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  try {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub rejects a request without one, and the updater has no other identity.
      'user-agent': 'dsh-plugin-updater',
      ...(typeof token === 'string' && token !== '' ? { authorization: `Bearer ${token}` } : {}),
    }
    const response = await fetch(`${API}${path}`, { headers, signal: controller.signal })
    // A refused rate limit is its own outcome: the caller must be able to say
    // "GitHub is throttling this machine" rather than "no such repository".
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      return { ok: false, problem: remaining === '0' ? 'rate-limited' : 'forbidden' }
    }
    if (response.status === 404) return { ok: false, problem: 'not-found' }
    if (!response.ok) return { ok: false, problem: 'lookup-failed' }
    return { ok: true, body: await response.json() }
  } catch (error) {
    return { ok: false, problem: error?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the repository a marketplace-style install spec names.
 * @param spec - an install spec such as `github:owner/repo` or a repository URL.
 * @returns the `owner/repo` slug, or undefined.
 */
export function repoOf(spec) {
  if (typeof spec !== 'string') return undefined
  const trimmed = spec.trim().replace(/^github:/i, 'https://github.com/').replace(/^git\+/i, '')
  const ssh = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed)
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
    return parts.length >= 2 && parts[0] !== '' && parts[1] !== '' ? `${parts[0]}/${parts[1]}` : undefined
  } catch {
    return undefined
  }
}
