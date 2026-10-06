/**
 * Pure decision logic for the plugin updater: what may be updated, and whether a
 * registry version is actually newer.
 *
 * Everything here is a pure function so the whole policy is unit-testable without
 * a Host, a registry, or pnpm. Nothing in this file touches the filesystem, the
 * network, or a cordis context.
 * @module dsh-plugin-updater/lib/policy
 */

/**
 * Packages that ship with DSH and therefore follow the DSH release rather than a
 * registry. This mirrors the official plugin page's own exclusion set
 * (`BUILTIN_PROFILE_BUNDLES` in `@deepseek-ai/dsh-client-ui-plugin-manager`) so the
 * updater and the page agree on what a "built-in" is.
 */
export const BUILTIN_PROFILE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
])

/**
 * A registry package name: an optional scope, then segments that start with a
 * letter or digit.
 *
 * Each segment's first character is deliberately alphanumeric. npm's own rules
 * tolerate a leading `-` in a package name, but this value is concatenated into a
 * `name@version` argument handed to pnpm, and nothing legitimate in the ecosystem
 * starts a segment with `-`. Refusing the shape here means a malformed request can
 * never produce a token that pnpm reads as an option.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/

/**
 * A version the updater is willing to hand to pnpm as `<name>@<version>`.
 *
 * No leading `v` and no range syntax: the value is concatenated into a package
 * spec, so only the exact published-release shape is accepted.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** How a dependency string names something other than a registry version. */
const NON_REGISTRY_SPEC = /^(?:link|file|workspace|portal|patch|git|github|https?|npm):/i

/** Why one installed bundle cannot be checked for updates. */
export const SKIP = {
  /** Not a registry dependency: a path, a link, a workspace, a git address or a tarball. */
  notRegistry: 'not-registry',
  /** The bundle carries no readable version, so there is nothing to compare against. */
  noVersion: 'no-version',
  /** The installed version is not a semver the updater will compare or install. */
  notSemver: 'not-semver',
  /** The bundle ships with DSH and follows the DSH release. */
  builtin: 'builtin',
  /** A bundle shipped switched off: it follows the DSH release too. */
  optional: 'optional',
}

/** Human-readable reason text, kept here so both halves word it the same way. */
export const SKIP_REASON = {
  [SKIP.notRegistry]: 'not installed from a registry',
  [SKIP.noVersion]: 'no installed version',
  [SKIP.notSemver]: 'installed version is not a release version',
  [SKIP.builtin]: 'ships with DSH',
  [SKIP.optional]: 'ships with DSH as an optional bundle',
}

/**
 * Whether a string is a package name the updater will accept from a request.
 * @param name - the candidate package name.
 * @returns true when the name is usable as both a registry name and a command argument.
 */
export function isPackageName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 214 && PACKAGE_NAME.test(name)
}

/**
 * Whether a string is a release version the updater will accept from a request.
 * @param version - the candidate version.
 * @returns true when the version is a plain or prerelease semver with no range syntax.
 */
export function isReleaseVersion(version) {
  return typeof version === 'string' && SEMVER.test(version)
}

/**
 * Split a version into its comparable parts.
 * @param version - a version string that already passed {@link isReleaseVersion}.
 * @returns numeric core, prerelease identifiers, and build metadata.
 */
function parse(version) {
  const cleaned = version.startsWith('v') ? version.slice(1) : version
  const plus = cleaned.indexOf('+')
  const withoutBuild = plus === -1 ? cleaned : cleaned.slice(0, plus)
  const dash = withoutBuild.indexOf('-')
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const prerelease = dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.')
  return { core: core.split('.').map(Number), prerelease }
}

/**
 * Compare one prerelease identifier against another by semver's own rules: numeric
 * identifiers compare numerically, alphanumeric ones compare by ASCII, and a
 * numeric identifier always sorts below an alphanumeric one.
 * @param a - left identifier.
 * @param b - right identifier.
 * @returns negative, zero, or positive.
 */
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * Compare two release versions by semver precedence.
 *
 * A prerelease sorts below the release it leads to (`1.0.0-rc.9 < 1.0.0`) and a
 * longer prerelease run wins when every earlier identifier is equal
 * (`1.0.0-rc.2 < 1.0.0-rc.2.1`). Build metadata is ignored.
 * @param a - left version.
 * @param b - right version.
 * @returns negative when a precedes b, zero when equal, positive when a follows b.
 */
export function compareVersions(a, b) {
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const difference = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (difference !== 0) return difference
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const difference = compareIdentifier(l, r)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Decide whether one installed bundle is a candidate for registry updates.
 *
 * The dependency string is checked before the version because a `link:` or
 * `workspace:` dependency has no registry version to compare, and the official
 * page lists such a bundle exactly like any other.
 * @param bundle - one `listBundles()` row.
 * @param dependency - the profile manifest's dependency string for that bundle.
 * @returns the reason to skip it, or undefined when it may be updated.
 */
export function skipReason(bundle, dependency) {
  if (typeof bundle?.name !== 'string' || bundle.name === '') return SKIP.notRegistry
  if (BUILTIN_PROFILE_BUNDLES.has(bundle.name)) return SKIP.builtin
  if (bundle.optional === true) return SKIP.optional
  if (bundle.installed !== true) return SKIP.notRegistry
  if (typeof dependency === 'string' && NON_REGISTRY_SPEC.test(dependency.trim())) return SKIP.notRegistry
  if (typeof bundle.version !== 'string' || bundle.version === '') return SKIP.noVersion
  if (!isReleaseVersion(bundle.version)) return SKIP.notSemver
  return undefined
}

/**
 * Build the ordered list of registries to ask, matching the official manager's
 * own plan: the resolved first registry, then the configured fallbacks, each once.
 * @param registries - the answer from `pluginManager.registries()`.
 * @returns registry URLs in ask order; a `null` member means pnpm's own configuration.
 */
export function registryPlan(registries) {
  const configured = typeof registries?.registry === 'string' ? registries.registry : null
  const resolved = typeof registries?.resolved === 'string' ? registries.resolved : null
  const fallbacks = Array.isArray(registries?.fallbackRegistries) ? registries.fallbackRegistries : []
  const order = [resolved ?? configured, ...fallbacks]
  const seen = new Set()
  const plan = []
  for (const registry of order) {
    if (registry !== null && typeof registry !== 'string') continue
    const key = registry === null ? '<pnpm>' : registry.replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    plan.push(registry)
  }
  return plan.length > 0 ? plan : [null]
}

/** A scannable answer for one package after its registry lookup. */
export const OUTCOME = {
  update: 'update',
  current: 'current',
  skip: 'skip',
  unknown: 'unknown',
}

/**
 * Turn one installed bundle plus its registry answer into the row the browser renders.
 * @param bundle - one `listBundles()` row.
 * @param skip - the skip reason from {@link skipReason}, when there is one.
 * @param latest - the registry's `latest` version, or undefined when none was read.
 * @param problem - why the lookup failed, when it did.
 * @param registry - the registry that answered.
 * @returns one check result.
 */
export function checkResult(bundle, skip, latest, problem, registry) {
  const base = {
    name: bundle.name,
    ...(typeof bundle.version === 'string' ? { installed: bundle.version } : {}),
    ...(bundle.enabled === true ? { enabled: true } : {}),
  }
  if (skip !== undefined) return { ...base, outcome: OUTCOME.skip, reason: SKIP_REASON[skip] ?? skip }
  if (problem !== undefined) return { ...base, outcome: OUTCOME.unknown, problem }
  if (typeof latest !== 'string' || latest === '') return { ...base, outcome: OUTCOME.unknown, problem: 'no-answer' }
  if (!isReleaseVersion(latest)) return { ...base, outcome: OUTCOME.unknown, problem: 'unreadable-version' }
  const ahead = compareVersions(latest, bundle.version) > 0
  return {
    ...base,
    outcome: ahead ? OUTCOME.update : OUTCOME.current,
    ...(ahead ? { latest } : {}),
    ...(registry === undefined || registry === null ? {} : { registry }),
  }
}

/**
 * Re-check a version the browser asked for against the live registry answer.
 *
 * The browser's request names both a package and a target, so both are re-validated
 * here against the installed set and the fetched version rather than trusted.
 * @param name - the package the request names.
 * @param target - the version the request names.
 * @param bundles - the live `listBundles()` rows.
 * @param dependencies - the profile manifest's dependencies.
 * @param latest - the latest version read from the registry for that package.
 * @returns a refusal reason, or undefined when the update may proceed.
 */
export function refuseUpdate(name, target, bundles, dependencies, latest) {
  if (!isPackageName(name)) return 'invalid-name'
  if (!isReleaseVersion(target)) return 'invalid-version'
  const bundle = Array.isArray(bundles) ? bundles.find((item) => item?.name === name) : undefined
  if (bundle === undefined) return 'unknown-package'
  const skip = skipReason(bundle, dependencies?.[name])
  if (skip !== undefined) return skip
  if (compareVersions(target, bundle.version) <= 0) return 'not-newer'
  if (typeof latest === 'string' && latest !== '' && compareVersions(target, latest) > 0) return 'ahead-of-registry'
  return undefined
}
