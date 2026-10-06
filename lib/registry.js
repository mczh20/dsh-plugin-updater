/**
 * Registry lookups through the profile's own pnpm.
 *
 * The updater deliberately does not speak HTTP to a registry: a profile's
 * `.npmrc`, its proxy settings, its authentication and its private registries are
 * pnpm's own configuration, and the official manager already reads a version
 * through `pnpm view` for exactly that reason. Asking the same way means an update
 * resolves the same version the install will fetch.
 * @module dsh-plugin-updater/lib/registry
 */

import { registryPlan } from './policy.js'

/** How long one registry is given to answer before the next one is asked. */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 20_000

/**
 * The command and prefix arguments that run pnpm for this profile.
 *
 * A bundled Desktop runtime supplies its own package manager as an executable
 * plus a script path, so the command is never assumed to be on PATH.
 * @param profile - launcher facts: `dir`, `packageManager`, `installAnchor`.
 * @returns the executable, its fixed prefix arguments, and the environment.
 */
export function pnpmInvocation(profile) {
  const command = profile?.packageManager?.command ?? 'pnpm'
  const args = Array.isArray(profile?.packageManager?.args) ? profile.packageManager.args : []
  return { command, args, env: profile?.packageManager?.env }
}

/**
 * Run one pnpm command in the profile directory.
 *
 * The run is bounded twice over: `timeoutMs` bounds the whole operation, and an
 * abort signal ends it when the manager is disposed.
 * @param profile - launcher facts.
 * @param args - pnpm arguments, after the fixed prefix.
 * @param options - time bound, abort signal, and captured-output bound.
 * @returns the exit code, combined output, and whether the bound was reached.
 */
async function run(profile, args, options) {
  const { spawn } = await import('node:child_process')
  const { command, args: prefix, env } = pnpmInvocation(profile)
  const child = spawn(command, [...prefix, ...args], {
    cwd: profile.dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const limit = options.outputBytes ?? 16_384
  let output = ''
  let timedOut = false
  const collect = (chunk) => {
    if (output.length < limit) output += String(chunk)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS)
  const abort = () => child.kill()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { exitCode: exitCode ?? 1, output: output.trim(), timedOut }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/**
 * Read one package's `latest` version from the registries this profile asks.
 *
 * Registries are tried in the manager's own order and the first reachable one that
 * knows the package wins; a mirror that has not synced the package yet is
 * indistinguishable from one that does not carry it, so both fall through.
 * @param profile - launcher facts.
 * @param name - the package name.
 * @param registries - the answer from `pluginManager.registries()`.
 * @param options - time bound and abort signal.
 * @returns the latest version, the registry that answered, and any problem.
 */
export async function fetchLatest(profile, name, registries, options = {}) {
  const plan = registryPlan(registries)
  const asked = []
  let lastProblem = 'no-registry'
  for (const registry of plan) {
    const args = ['view', name, 'version', '--json']
    if (registry !== null) args.push(`--registry=${registry}`)
    let result
    try {
      result = await run(profile, args, options)
    } catch (error) {
      lastProblem = 'spawn-failed'
      asked.push({ registry, problem: String(error?.message ?? error) })
      continue
    }
    const label = registry ?? '<pnpm>'
    if (result.timedOut) {
      lastProblem = 'timeout'
      asked.push({ registry: label, problem: 'timeout' })
      continue
    }
    if (result.exitCode !== 0) {
      const log = result.output.toLowerCase()
      lastProblem = log.includes('e404') || log.includes('not found') ? 'not-found' : 'lookup-failed'
      asked.push({ registry: label, problem: lastProblem })
      continue
    }
    const version = parseVersion(result.output)
    if (version === undefined) {
      lastProblem = 'unreadable-answer'
      asked.push({ registry: label, problem: lastProblem })
      continue
    }
    return { latest: version, registry, asked }
  }
  return { problem: lastProblem, asked }
}

/**
 * Read a version out of `pnpm view <name> version --json` output.
 *
 * pnpm prints a bare JSON string for a single field; older versions print a JSON
 * array when the field resolves more than once, and a mirror may wrap the answer.
 * @param output - the captured stdout.
 * @returns the version, or undefined when nothing usable was printed.
 */
export function parseVersion(output) {
  if (typeof output !== 'string') return undefined
  const text = output.trim()
  if (text === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const value = Array.isArray(parsed) ? parsed.at(-1) : parsed
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (typeof value === 'object' && value !== null && typeof value.version === 'string') return value.version
  return undefined
}
