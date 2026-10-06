/**
 * The updater's Host half: loopback-fenced routes over the official plugin manager.
 *
 * This half owns no package state of its own. It reads the profile through
 * `pluginManager`, performs every write through `pluginManager.installBundle`, and
 * exposes the two questions the Plugins page cannot otherwise ask: which installed
 * plugins have a newer registry version, and how an update to one of them ended.
 *
 * Direct service calls carry no approval prompt — the manager's approval gate sits
 * on its agent-facing *tool* — so the loopback fence in `./fence.js` is the only
 * boundary protecting a local code-execution capability. It is applied to every
 * route without exception.
 * @module dsh-plugin-updater
 */

import { UpdateEngine } from './engine.js'
import { isTrustedRequest, json, readJsonBody } from './fence.js'
import { isPackageName, isReleaseVersion } from './policy.js'

/** Stable cordis plugin name; must match the insert id in cordis.patch.yml. */
export const name = 'plugin-updater'

/**
 * Services this half needs. `webServer` carries the routes; `pluginManager` is the
 * only writer of profile package state and answers the installed inventory,
 * registries, and install run.
 */
export const inject = ['webServer', 'pluginManager']

/** Route prefix the browser half mirrors. */
export const ROUTE_PREFIX = '/api/plugin-updater'

/**
 * Build the routes, sharing one engine so only one update runs at a time.
 * @param engine - the shared update engine.
 * @returns the web-server routes to register.
 */
export function makeRoutes(engine) {
  /**
   * Wrap one handler in the trust fence, uniform JSON errors, and the method guard.
   * @param handler - the route body, given the parsed request body and the request.
   * @param options - the HTTP method the route accepts, and whether it reads a body.
   * @returns a Node request handler.
   */
  const route = (handler, options = {}) => async (req, res) => {
    if (!isTrustedRequest(req)) {
      json(res, 403, { error: 'forbidden', reason: 'the plugin updater answers loopback requests from its own origin only' })
      return
    }
    if (options.method !== undefined && req.method !== options.method) {
      json(res, 405, { error: 'method-not-allowed', method: options.method })
      return
    }
    try {
      const body = options.body === true ? await readJsonBody(req) : {}
      json(res, 200, await handler(body, req))
    } catch (error) {
      json(res, 400, { error: 'request-failed', reason: String(error?.message ?? error) })
    }
  }

  return [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/check`,
      handler: route(async () => engine.check()),
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: route(async () => engine.state()),
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/update`,
      handler: route(async (body) => {
        const target = body.target
        if (!isPackageName(body.name)) throw new Error('a package name is required')
        if (!isReleaseVersion(target)) throw new Error('a release version is required')
        return engine.update(body.name, target)
      }, { method: 'POST', body: true }),
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/update-all`,
      handler: route(async (body) => {
        const targets = body.targets
        if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
          throw new Error('targets must be an object mapping package names to versions')
        }
        const results = []
        for (const [packageName, target] of Object.entries(targets)) {
          if (!isPackageName(packageName) || !isReleaseVersion(target)) continue
          // One failure never stops the batch: each package is independent, and the
          // page reports the survivors and the casualties together.
          results.push(await engine.update(packageName, target))
        }
        return { results }
      }, { method: 'POST', body: true }),
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/versions`,
      handler: route(async (body, req) => {
        // A GET carries its arguments in the query string; the fence has already run.
        const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
        if (!isPackageName(name)) throw new Error('a package name is required')
        return engine.versions(name)
      }, { method: 'GET' }),
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/install`,
      handler: route(async (body) => {
        if (!isPackageName(body.name)) throw new Error('a package name is required')
        // The version is either a release or a git ref. Both are validated by shape
        // here and again against the freshly read history inside the engine, which is
        // what actually decides what reaches pnpm.
        if (typeof body.version !== 'string' || body.version === '' || body.version.length > 128) {
          throw new Error('a version is required')
        }
        if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(body.version)) throw new Error('the version is not usable')
        return engine.install(body.name, body.version)
      }, { method: 'POST', body: true }),
    },
  ]
}

/**
 * Mount the updater in the Web composition.
 * @param ctx - the plugin context carrying `webServer` and `pluginManager`.
 */
export function apply(ctx) {
  const engine = new UpdateEngine(ctx.pluginManager, ctx.logger)
  ctx.effect(() => {
    const disposers = makeRoutes(engine).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'plugin-updater: routes')
}
