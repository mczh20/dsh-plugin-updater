/**
 * The trust fence every updater route sits behind, and the JSON helpers those
 * routes answer with.
 *
 * This plugin performs local code execution: an update runs pnpm, which runs the
 * target package's install scripts. The fence is therefore the only thing between
 * a web page and that execution, and it mirrors the official installer channel's
 * own authority — a loopback socket, a loopback Host header, and browser
 * same-origin markers. X-Forwarded-For is never consulted, because a peer's own
 * header is not evidence about the peer.
 * @module dsh-plugin-updater/lib/fence
 */

/** The largest request body the updater will read. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Whether an IPv4 literal names the loopback range.
 * @param value - the address text.
 * @returns true for 127/8.
 */
export function isIPv4Loopback(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket address names the local machine.
 * @param address - `req.socket.remoteAddress`, possibly undefined.
 * @returns true for 127/8, ::1, and IPv4-mapped loopback.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (bare === '::1') return true
  return isIPv4Loopback(bare)
}

/**
 * Whether a Host header names the local machine.
 * @param host - the raw Host header value.
 * @returns true for localhost and loopback literals, with or without a port.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  const trimmed = host.trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed)
  if (bracketed !== null) return bracketed[1] === '::1'
  const withoutPort = trimmed.replace(/:\d+$/, '')
  if (withoutPort.toLowerCase() === 'localhost') return true
  return isIPv4Loopback(withoutPort)
}

/**
 * Whether a request comes from a page this very server could have served.
 *
 * A browser sends `Origin` on every cross-origin request and `Sec-Fetch-Site` on
 * every fetch; requiring both to describe a same-origin loopback page keeps a
 * hostile page on the same machine from driving updates through a victim's browser.
 * @param req - the incoming request.
 * @returns true when the request may be acted on.
 */
export function isSameOriginLoopback(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (!isLoopbackHost(parsed.host)) return false
  }
  return true
}

/**
 * The whole fence for one request.
 * @param req - the incoming request.
 * @returns true when the request may be acted on.
 */
export function isTrustedRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHost(req.headers.host) && isSameOriginLoopback(req)
}

/**
 * Answer one request with JSON.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the JSON-serializable body.
 */
export function json(res, status, body) {
  const text = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Read and parse a JSON request body under a fixed bound.
 * @param req - the incoming request.
 * @returns the parsed body; an empty body parses to an empty object.
 * @throws {Error} when the body exceeds the bound or is not valid JSON.
 */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}
