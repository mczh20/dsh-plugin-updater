/**
 * The update engine: one package at a time, through the official manager, with the
 * repair an interrupted install needs.
 *
 * Two facts shape this file.
 *
 * First, every write goes through `pluginManager.installBundle`. It is the
 * manager's own pnpm path, it snapshots the profile's `package.json` and
 * `pnpm-lock.yaml` before pnpm runs, and it is the only writer that keeps the
 * profile's selection list consistent with its dependencies. The updater never
 * runs pnpm to change a profile itself.
 *
 * Second, an install of a package that was already a dependency skips the manager's
 * own reload, so the new files would not be the running ones until a restart. The
 * engine performs that reload itself, which is what makes an update take effect
 * immediately.
 * @module dsh-plugin-updater/lib/engine
 */

import { fetchLatest } from './registry.js'
import { OUTCOME, checkResult, compareVersions, refuseUpdate, skipReason } from './policy.js'
import { SOURCE, githubVersions, lockedCommit, registryVersions, repofromSpec, sourceOf } from './versions.js'
import { fetchGithubVersions, fetchPackument } from './version-source.js'

/** How many registry lookups run at once, so one check does not open a process per package. */
const LOOKUP_CONCURRENCY = 4

/**
 * One updater run: which package is being updated, how far it has got, and how it
 * ended. The browser reads this shape directly.
 */
export class UpdateEngine {
  #manager
  #logger
  #running = null
  #lastRun = null
  #listeners = new Set()

  /**
   * @param manager - the live `pluginManager` service.
   * @param logger - the Host logger, used for self-healing diagnostics.
   */
  constructor(manager, logger) {
    this.#manager = manager
    this.#logger = logger
  }

  /** Subscribe to run-state changes; the returned function unsubscribes. */
  onChange(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Broadcast the current run state. */
  #announce() {
    const snapshot = this.state()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.#logger?.warn?.(error)
      }
    }
  }

  /** The run currently in flight, or the one that finished last. */
  state() {
    return { running: this.#running === null ? null : { ...this.#running }, lastRun: this.#lastRun }
  }

  /** Whether an update is in flight. */
  get busy() {
    return this.#running !== null
  }

  /**
   * Read the profile's installed bundles and the manifest's dependency strings.
   * @returns the live bundle rows and the dependency strings keyed by name.
   */
  async inventory() {
    const bundles = await this.#manager.listBundles()
    const dependencies = await this.#dependencies()
    return { bundles: Array.isArray(bundles) ? bundles : [], dependencies }
  }

  /**
   * Read the profile manifest's dependencies.
   *
   * `listBundles` answers versions and activation but not the requested dependency
   * string, and that string is what distinguishes a registry dependency from a
   * `link:` one that has no registry version at all.
   * @returns dependency strings keyed by package name; empty when unreadable.
   */
  async #dependencies() {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dir = this.#manager?.profile?.dir ?? this.#profileDir
      if (typeof dir !== 'string' || dir === '') return {}
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      return manifest?.dependencies ?? {}
    } catch (error) {
      this.#logger?.warn?.(error)
      return {}
    }
  }

  /** The profile directory, when the manager exposes it. */
  get #profileDir() {
    return this.#manager?.profile?.dir
  }

  /**
   * The commit each git dependency is pinned to, from the profile's lockfile.
   *
   * The manifest names a repository but not a revision, and the lockfile is the only
   * place the resolved commit is recorded. The picker uses it to mark which row is
   * the one currently installed.
   * @returns commit hashes keyed by package name; empty when unreadable.
   */
  async #lockedCommits() {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dir = this.#profileDir
      if (typeof dir !== 'string' || dir === '') return {}
      const text = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')
      const out = {}
      // Read the importer block by line rather than parsing YAML: the file is
      // machine-written, and only the two indented lines under each name matter.
      const lines = text.split('\n')
      let inImporter = false
      let current
      for (const line of lines) {
        if (/^\S/.test(line)) inImporter = line.startsWith('importers:')
        if (!inImporter) continue
        const name = /^ {6}'?([^':]+)'?:$/.exec(line)
        if (name !== null) {
          current = name[1]
          continue
        }
        const version = /^ {8}version:\s*(.+?)\s*$/.exec(line)
        if (version !== null && current !== undefined) {
          const commit = lockedCommit(version[1])
          if (commit !== undefined) out[current] = commit
          current = undefined
        }
      }
      return out
    } catch (error) {
      this.#logger?.warn?.(error)
      return {}
    }
  }

  /**
   * List the versions a package could be moved to.
   *
   * Which source answers depends on how the package was installed, because that is
   * where its history actually lives: a registry keeps every published version with
   * its own compatibility range, while a git dependency has whatever revisions the
   * repository has. A `link:` dependency has no history at all, and says so.
   * @param name - the package name.
   * @param signal - ends the lookup early.
   * @returns the source, the rows, and any problem.
   */
  async versions(name, signal) {
    const { bundles, dependencies } = await this.inventory()
    const bundle = bundles.find((item) => item?.name === name)
    if (bundle === undefined) return { problem: 'unknown-package' }

    const dependency = dependencies[name]
    const source = sourceOf(dependency)
    if (source === SOURCE.local) {
      return { source, versions: [], problem: 'local-source', current: bundle.version }
    }

    if (source === SOURCE.github) {
      const repo = repofromSpec(dependency)
      if (repo === undefined) return { source, versions: [], problem: 'unreadable-repo' }
      const commits = await this.#lockedCommits()
      const answer = await fetchGithubVersions(repo, signal)
      if (answer.problem !== undefined) return { source, versions: [], problem: answer.problem, repo, current: bundle.version }
      const rows = githubVersions({
        tags: answer.tags ?? [],
        commits: answer.commits ?? [],
        currentRef: commits[name],
        currentVersion: bundle.version,
      })
      return {
        source,
        repo,
        current: bundle.version,
        currentRef: commits[name],
        // Neither a tag list nor a commit list states a DSH range, and reading one
        // per row would spend a request per row. The column is left empty by design.
        rangeKnown: false,
        versions: rows,
      }
    }

    const registries = await this.#manager.registries()
    const answer = await fetchPackument(registries, name, signal)
    if (answer.problem !== undefined) return { source, versions: [], problem: answer.problem, current: bundle.version }
    return {
      source,
      registry: answer.registry,
      current: bundle.version,
      rangeKnown: true,
      versions: registryVersions(answer.packument, bundle.version),
    }
  }

  /**
   * Check every installed bundle for a newer registry version.
   * @param signal - ends the whole batch when the caller goes away.
   * @returns one result per installed bundle, in listing order.
   */
  async check(signal) {
    const { bundles, dependencies } = await this.inventory()
    const registries = await this.#manager.registries()
    const candidates = []
    const results = []
    for (const bundle of bundles) {
      const skip = skipReason(bundle, dependencies[bundle.name])
      if (skip !== undefined) {
        results.push(checkResult(bundle, skip))
        continue
      }
      candidates.push(bundle)
    }
    for (let start = 0; start < candidates.length; start += LOOKUP_CONCURRENCY) {
      if (signal?.aborted === true) break
      const slice = candidates.slice(start, start + LOOKUP_CONCURRENCY)
      const answers = await Promise.all(
        slice.map(async (bundle) => {
          const answer = await fetchLatest(this.#profile(), bundle.name, registries, { signal })
          return checkResult(bundle, undefined, answer.latest, answer.problem, answer.registry)
        }),
      )
      results.push(...answers)
    }
    // Keep the page's own order: the browser matches rows by name, but a stable
    // order keeps a scroll position meaningful across two checks.
    const order = new Map(bundles.map((bundle, index) => [bundle.name, index]))
    results.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    return { checkedAt: new Date().toISOString(), results }
  }

  /** The launcher facts the registry client needs. */
  #profile() {
    return { dir: this.#profileDir, packageManager: this.#manager?.profile?.packageManager }
  }

  /**
   * Update one installed bundle to a version the caller names.
   *
   * The caller's target is re-validated against the live registry rather than
   * trusted, and the update is confirmed against the registry again so a browser
   * cannot ask for an arbitrary spec or a version that does not exist.
   * @param name - the package name.
   * @param target - the version to move to.
   * @param options - the registry that answered, and an abort signal.
   * @returns the run result the browser renders.
   */
  async update(name, target, options = {}) {
    if (this.#running !== null) {
      return { name, status: 'busy', failure: { code: 'busy' } }
    }
    const started = Date.now()
    this.#running = { name, target, phase: 'checking', startedAt: new Date(started).toISOString() }
    this.#announce()
    let outcome
    try {
      outcome = await this.#update(name, target, options)
    } catch (error) {
      outcome = { name, status: 'failed', failure: { code: 'unexpected', diagnostic: String(error?.message ?? error) } }
    }
    this.#lastRun = { ...outcome, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started }
    this.#running = null
    this.#announce()
    return outcome
  }

  /**
   * Install one specific version of an installed package, up or down.
   *
   * This is the version picker's write path. Unlike {@link update} it accepts a
   * downgrade, because reverting a broken upgrade is the main reason to pick a
   * version at all. What it does *not* relax is where the request may point: the
   * package must already be installed, the spec is rebuilt from that package's own
   * dependency string, and the version must appear in the history this engine just
   * read — so a browser can neither install something new nor aim a git install at
   * another repository.
   * @param name - the package name.
   * @param version - the version or revision to install.
   * @param options - an abort signal.
   * @returns the run result the browser renders.
   */
  async install(name, version, options = {}) {
    if (this.#running !== null) return { name, status: 'busy', failure: { code: 'busy' } }
    const started = Date.now()
    this.#running = { name, target: version, phase: 'checking', startedAt: new Date(started).toISOString() }
    this.#announce()
    let outcome
    try {
      outcome = await this.#install(name, version, options)
    } catch (error) {
      outcome = { name, status: 'failed', failure: { code: 'unexpected', diagnostic: String(error?.message ?? error) } }
    }
    this.#lastRun = { ...outcome, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started }
    this.#running = null
    this.#announce()
    return outcome
  }

  /**
   * The version install itself: re-list the history, confirm the choice, install.
   * @param name - the package name.
   * @param version - the requested version or revision.
   * @param options - an abort signal.
   * @returns the run result.
   */
  async #install(name, version, options) {
    const { bundles, dependencies } = await this.inventory()
    const bundle = bundles.find((item) => item?.name === name)
    if (bundle === undefined) return { name, status: 'refused', failure: { code: 'unknown-package' } }
    const dependency = dependencies[name]
    const source = sourceOf(dependency)
    if (source === SOURCE.local) return { name, status: 'refused', failure: { code: 'local-source' } }
    if (typeof version !== 'string' || version === '') return { name, status: 'refused', failure: { code: 'invalid-version' } }

    // Re-read the history and take the row's own `ref` from it, so the value that
    // reaches pnpm is one this engine produced rather than one the caller sent.
    const history = await this.versions(name, options.signal)
    if (history.problem !== undefined) return { name, status: 'refused', failure: { code: history.problem } }
    const row = history.versions.find((item) => item.version === version || item.ref === version)
    if (row === undefined) return { name, status: 'refused', failure: { code: 'unknown-version' } }
    if (row.isCurrent === true) return { name, status: 'refused', failure: { code: 'already-current' } }

    // The spec is rebuilt from the package's own source: a registry name takes the
    // exact version, a git dependency takes its own repository at the requested ref.
    const spec = source === SOURCE.github ? `github:${history.repo}#${row.ref}` : `${name}@${row.version}`
    if (source === SOURCE.github && history.repo === undefined) {
      return { name, status: 'refused', failure: { code: 'unreadable-repo' } }
    }

    this.#running = { ...this.#running, phase: 'installing' }
    this.#announce()

    const requestId = `updater-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const previous = bundle.version
    const wasEnabled = bundle.enabled === true
    let failure
    try {
      await this.#manager.installBundle(spec, { enabled: wasEnabled, requestId })
    } catch (error) {
      failure = describeFailure(error)
    }

    this.#running = { ...this.#running, phase: 'verifying' }
    this.#announce()

    const landed = await this.#landedVersion(name)
    const repaired = failure === undefined ? undefined : await this.#heal(name, previous, landed)
    if (failure !== undefined) {
      return { name, status: 'failed', from: previous, target: row.version, ...(repaired === undefined ? {} : { repaired }), failure }
    }

    const applied = await this.#applyLive(name, wasEnabled)
    return {
      name,
      status: applied.live ? 'updated' : 'restart-required',
      from: previous,
      to: landed ?? row.version,
      requestId,
      installed: row.version,
      source,
      ...(applied.live ? {} : { changedOnRestart: true }),
      ...(applied.warning === undefined ? {} : { warning: applied.warning }),
    }
  }

  /**
   * The update itself: validate, install, then confirm what actually landed.
   * @param name - the package name.
   * @param target - the requested version.
   * @param options - registry and abort signal.
   * @returns the run result.
   */
  async #update(name, target, options) {
    const { bundles, dependencies } = await this.inventory()
    const bundle = bundles.find((item) => item?.name === name)
    if (bundle === undefined) return { name, status: 'refused', failure: { code: 'unknown-package' } }

    const registries = await this.#manager.registries()
    const answer = await fetchLatest(this.#profile(), name, registries, { signal: options.signal })
    const refusal = refuseUpdate(name, target, bundles, dependencies, answer.latest)
    if (refusal !== undefined) {
      return { name, status: 'refused', from: bundle.version, target, failure: { code: refusal } }
    }

    this.#running = { ...this.#running, phase: 'installing' }
    this.#announce()

    const requestId = `updater-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const previous = bundle.version
    // Carry the bundle's own activation across the update.
    //
    // `installBundle` selects whatever it installs unless the caller passes
    // `enabled: false`, and `selectBundle(name, true)` *adds* the name to the
    // profile's bundle list. Passing an unconditional `true` therefore switches on a
    // plugin the person had deliberately switched off: an update must change the
    // version and nothing else. Passing the bundle's current selection is the safe
    // form on both branches — an already-selected bundle is selected again, which
    // `selectBundle` ignores, and an unselected one skips the step entirely.
    const wasEnabled = bundle.enabled === true
    let result
    let failure
    try {
      result = await this.#manager.installBundle(`${name}@${target}`, {
        enabled: wasEnabled,
        requestId,
        ...(answer.registry === undefined || answer.registry === null ? {} : { registry: answer.registry }),
      })
    } catch (error) {
      failure = describeFailure(error)
    }

    this.#running = { ...this.#running, phase: 'verifying' }
    this.#announce()

    const landed = await this.#landedVersion(name)
    const repaired = failure === undefined ? undefined : await this.#heal(name, previous, landed)

    if (failure !== undefined) {
      return {
        name,
        status: 'failed',
        from: previous,
        target,
        ...(repaired === undefined ? {} : { repaired }),
        failure,
      }
    }

    const warnings = Array.isArray(result?.warnings) ? result.warnings : []
    const pendingBuilds = Array.isArray(result?.pendingBuilds) ? result.pendingBuilds : []
    if (pendingBuilds.length > 0) {
      return { name, status: 'failed', from: previous, target, failure: { code: 'build-blocked', pendingBuilds } }
    }
    // `installBundle` reports the saved selection rather than a successful load, so
    // the version on disk is what says the update actually took.
    if (landed !== undefined && compareVersions(landed, previous) <= 0) {
      return { name, status: 'failed', from: previous, target, failure: { code: 'not-applied' } }
    }

    // Load the new code now, rather than leaving it for the next process start.
    //
    // `installBundle` deliberately skips its own reload for a package that was
    // already a dependency — which is every update — because re-selecting an
    // unchanged bundle is meaningless for an install. A *replacement* is a different
    // case: the package on disk is new, so re-selecting the same bundle is exactly
    // what rebuilds the composition from the new bytes. This is the same reload the
    // page's own on/off switch performs.
    const applied = await this.#applyLive(name, wasEnabled)

    return {
      name,
      status: applied.live ? 'updated' : 'restart-required',
      from: previous,
      to: landed ?? target,
      requestId,
      ...(applied.live ? {} : { changedOnRestart: true }),
      ...(applied.warning === undefined ? {} : { warning: applied.warning }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /**
   * Re-compose the profile so the freshly installed bytes are the ones running.
   *
   * The manager reloads only through `setBundleEnabled`, whose reload rebuilds the
   * root Include from the patches read off disk. Calling it with the bundle's
   * current selection is therefore a no-op on the saved manifest and a full reload
   * of the running tree: the package that was just replaced gets loaded again, this
   * time from its new files.
   *
   * A reload needs HMR, which a live profile has and a startup-only one does not. No
   * reload is attempted without it, and the caller is told the change still awaits a
   * restart, which is the truth on that profile.
   * @param name - the package name.
   * @param enabled - the selection the bundle already had.
   * @returns whether the running tree now holds the new code, and any warning.
   */
  async #applyLive(name, enabled) {
    const manager = this.#manager
    if (typeof manager.setBundleEnabled !== 'function') return { live: false }
    this.#running = { ...this.#running, phase: 'applying' }
    this.#announce()
    try {
      const result = await manager.setBundleEnabled(name, enabled)
      // `application` says what the manager did with the running profile:
      // `applied` for a live reload, `restart-required` when it has no HMR.
      const live = result?.application === 'applied'
      const warnings = Array.isArray(result?.warnings) ? result.warnings : []
      return { live, ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }) }
    } catch (error) {
      // The update itself already succeeded, so a failed reload is reported as a
      // pending restart rather than as a failed update.
      this.#logger?.warn?.(error)
      return { live: false, warning: String(error?.message ?? error) }
    }
  }

  /**
   * The version actually present on disk for one bundle.
   * @param name - the package name.
   * @returns the installed version, or undefined when the package is not resolvable.
   */
  async #landedVersion(name) {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dir = this.#profileDir
      if (typeof dir !== 'string' || dir === '') return undefined
      const manifest = JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8'))
      return typeof manifest?.version === 'string' ? manifest.version : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Put a package back when an interrupted install left it missing.
   *
   * pnpm removes the old top-level link before it creates the new one, so a
   * download that fails midway leaves the manifest naming a package that is no
   * longer installed — and the manager's own recovery (`pnpm install
   * --frozen-lockfile`) does not restore a missing link, because the lockfile is
   * already satisfied. Re-adding the exact previous version does restore it, and
   * the store still holds the tarball, so the repair does not re-download.
   * @param name - the package name.
   * @param previous - the version that was installed before the attempt.
   * @param landed - the version found on disk after the attempt.
   * @returns how the repair ended, or undefined when no repair was needed.
   */
  async #heal(name, previous, landed) {
    if (landed !== undefined) return undefined
    this.#running = { ...this.#running, phase: 'repairing' }
    this.#announce()
    try {
      const { spawn } = await import('node:child_process')
      const { command, args: prefix, env } = describePnpm(this.#manager?.profile)
      await new Promise((resolve, reject) => {
        const child = spawn(command, [...prefix, 'add', `${name}@${previous}`], {
          cwd: this.#profileDir,
          env: { ...process.env, ...env },
          stdio: 'ignore',
          windowsHide: true,
        })
        child.once('error', reject)
        child.once('close', resolve)
      })
      const restored = await this.#landedVersion(name)
      if (restored === undefined) return { status: 'failed' }
      return { status: 'restored', version: restored }
    } catch (error) {
      this.#logger?.warn?.(error)
      return { status: 'failed' }
    }
  }
}

/**
 * Describe a failed `installBundle` in terms the page can render.
 * @param error - the thrown value.
 * @returns a failure record.
 */
export function describeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  const incompatible = Array.isArray(error?.incompatible) ? error.incompatible : undefined
  if (code === 'incompatible-version') {
    return { code, ...(incompatible === undefined ? {} : { incompatible }) }
  }
  const pendingBuilds = Array.isArray(error?.pendingBuilds) ? error.pendingBuilds : undefined
  return {
    code: code ?? 'install-failed',
    diagnostic: String(error?.message ?? error ?? 'install failed'),
    ...(pendingBuilds === undefined ? {} : { pendingBuilds }),
  }
}

/**
 * The pnpm executable and prefix arguments for one profile.
 * @param profile - launcher facts.
 * @returns the executable, prefix arguments, and environment additions.
 */
export function describePnpm(profile) {
  return {
    command: profile?.packageManager?.command ?? 'pnpm',
    args: Array.isArray(profile?.packageManager?.args) ? profile.packageManager.args : [],
    env: profile?.packageManager?.env ?? {},
  }
}

export { OUTCOME }
