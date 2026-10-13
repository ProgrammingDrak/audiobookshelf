import http from 'node:http'
import https from 'node:https'
import { createReadStream, readFileSync, realpathSync, existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const base = '/audiobookshelf'
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.map': 'application/json', '.txt': 'text/plain' }

export function configuration(env = process.env, inContainer = existsSync('/.dockerenv')) {
  const upstream = new URL(env.ABS_UPSTREAM || 'http://127.0.0.1:13378')
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || !['/', '/audiobookshelf', '/audiobookshelf/'].includes(upstream.pathname)) throw new Error('ABS_UPSTREAM must be a credential-free HTTP(S) URL at / or /audiobookshelf')
  const origin = new URL(env.PUBLIC_ORIGIN || 'http://127.0.0.1:13379')
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin')
  const host = env.HOST || '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1' && !(host === '0.0.0.0' && env.CONTAINER_MODE === '1' && inContainer)) throw new Error('Gateway must bind to loopback outside an explicitly configured Docker container')
  const port = Number(env.PORT || 13379)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  let revision = 'local', clientVersion
  try { const metadata = JSON.parse(readFileSync(path.join(here, '../release.json'), 'utf8')); revision = metadata.revision; clientVersion = metadata.clientVersion } catch {}
  if (!clientVersion) try { clientVersion = JSON.parse(readFileSync(path.join(here, '../client/package.json'), 'utf8')).version } catch {}
  return { upstream, origin, host, port, dist: path.resolve(env.CLIENT_DIST || path.join(here, '../client/dist')), expectedVersion: env.EXPECTED_BACKEND_VERSION, revision: env.BUILD_REVISION || revision, clientVersion }
}

function cleanHeaders(input) {
  const headers = { ...input }
  for (const name of [...hopHeaders, ...(input.connection || '').toLowerCase().split(',').map(s => s.trim())]) delete headers[name]
  return headers
}

function json(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(error))
}

export function createGateway(config) {
  const { upstream, origin } = config
  const upstreamBase = upstream.pathname.replace(/\/$/, '')
  const transport = upstream.protocol === 'https:' ? https : http
  const sockets = new Set()

  function route(req) {
    // Reject absolute targets and ambiguous paths before WHATWG URL normalization.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return null
    const rawPath = req.url.split('?')[0]
    let decoded
    try { decoded = decodeURIComponent(rawPath) } catch { return null }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(p => p === '..' || p === '.') || /%2f|%5c/i.test(rawPath)) return null
    if (req.headers.host !== origin.host) return null
    if (req.headers.origin && req.headers.origin !== origin.origin) return null
    if (req.headers['sec-fetch-site'] === 'cross-site') return null
    const url = new URL(req.url, origin)
    if (!url.pathname.startsWith(base + '/') && url.pathname !== base && !['/', '/healthz', '/readyz'].includes(url.pathname)) return null
    return { url, local: url.pathname.slice(base.length) || '/' }
  }

  function requestHeaders(req, websocket = false) {
    const headers = cleanHeaders(req.headers)
    delete headers.forwarded
    for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-')) delete headers[key]
    headers.host = upstream.host
    headers['x-forwarded-host'] = origin.host
    headers['x-forwarded-proto'] = origin.protocol.slice(0, -1)
    // External identities/IPs are never trusted from client headers.
    headers['x-forwarded-for'] = req.socket.remoteAddress
    if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
    return headers
  }

  function responseHeaders(input) {
    const headers = cleanHeaders(input)
    headers['cache-control'] = 'no-store'
    headers['referrer-policy'] = 'no-referrer'
    // Refresh/session cookies stay HttpOnly/Secure/SameSite and become host-only.
    if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(cookie => cookie.replace(/;\s*domain=[^;]*/ig, ''))
    if (headers.location) {
      const location = new URL(headers.location, upstream)
      if (location.origin === upstream.origin && (upstreamBase === '' || location.pathname === upstreamBase || location.pathname.startsWith(upstreamBase + '/'))) headers.location = base + location.pathname.slice(upstreamBase.length) + location.search + location.hash
    }
    return headers
  }

  function proxy(req, res, route) {
    const request = transport.request(upstream, { method: req.method, path: upstreamBase + route.local + route.url.search, headers: requestHeaders(req) }, response => {
      res.writeHead(response.statusCode, responseHeaders(response.headers))
      response.on('error', () => res.destroy())
      response.pipe(res)
    })
    request.setTimeout(120_000, () => request.destroy())
    request.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'backend_unavailable' })
      else res.destroy()
    })
    req.on('aborted', () => request.destroy())
    res.on('close', () => { if (!res.writableFinished) request.destroy() })
    req.pipe(request)
  }

  async function ready(res) {
    if (!config.expectedVersion) return json(res, 503, { error: 'backend_version_unconfirmed' })
    if (config.clientVersion !== config.expectedVersion) return json(res, 503, { error: 'client_backend_version_mismatch' })
    try {
      const response = await fetch(upstream.origin + upstreamBase + '/status', { signal: AbortSignal.timeout(3000), redirect: 'error' })
      const status = await response.json()
      if (!response.ok || !status.isInit || status.serverVersion !== config.expectedVersion || !status.authMethods?.length) return json(res, 503, { error: 'backend_incompatible' })
      await stat(path.join(config.dist, 'index.html'))
      json(res, 200, { ok: true, revision: config.revision, backendVersion: status.serverVersion })
    } catch { json(res, 503, { error: 'backend_unavailable' }) }
  }

  async function staticFile(req, res, local) {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'method_not_allowed' })
    const root = await realpath(config.dist)
    const candidate = path.resolve(root, '.' + decodeURIComponent(local))
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return json(res, 400, { error: 'invalid_path' })
    let file = candidate
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
      file = await realpath(file)
    } catch {
      // Dynamic ABS routes use the generated SPA shell. Missing assets stay 404.
      if (path.extname(local) || local.startsWith('/_nuxt/') || local.startsWith('/libs/')) return json(res, 404, { error: 'not_found' })
      file = path.join(root, 'index.html')
    }
    if (!file.startsWith(root + path.sep)) return json(res, 403, { error: 'invalid_path' })
    const size = (await stat(file)).size
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'self'" })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }

  const server = http.createServer(async (req, res) => {
    const selected = route(req)
    if (!selected) return json(res, 400, { error: 'invalid_request' })
    if (selected.url.pathname === '/healthz') return json(res, 200, { ok: true, revision: config.revision })
    if (selected.url.pathname === '/readyz') return ready(res)
    if (selected.url.pathname === '/' || selected.url.pathname === base) {
      res.writeHead(302, { location: base + '/', 'cache-control': 'no-store' }); return res.end()
    }
    if (selected.local === '/init') return json(res, 403, { error: 'existing_backend_required' })
    if (/^\/(api|public|hls|auth|feed|socket\.io)(\/|$)/.test(selected.local) || ['/status', '/ping', '/healthcheck', '/logout'].includes(selected.local) || (selected.local === '/login' && req.method === 'POST')) return proxy(req, res, selected)
    try { await staticFile(req, res, selected.local) } catch { json(res, 503, { error: 'client_unavailable' }) }
  })

  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, client, head) => {
    const selected = route(req)
    if (!selected || !/^\/socket\.io\/?$/.test(selected.local) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return
    }
    const request = transport.request(upstream, { method: 'GET', path: upstreamBase + selected.local + selected.url.search, headers: requestHeaders(req, true) })
    request.setTimeout(10_000, () => request.destroy())
    request.on('upgrade', (response, backend, backendHead) => {
      request.setTimeout(0)
      backend.setTimeout(0)
      const headers = responseHeaders(response.headers)
      headers.connection = 'Upgrade'; headers.upgrade = 'websocket'
      client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${v}\r\n`)).join('') + '\r\n')
      if (backendHead.length) client.write(backendHead)
      if (head.length) backend.write(head)
      backend.on('error', () => client.destroy())
      client.on('error', () => backend.destroy())
      backend.on('close', () => client.destroy())
      client.on('close', () => backend.destroy())
      client.pipe(backend).pipe(client)
    })
    request.on('response', response => {
      client.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`)
      response.resume()
    })
    request.on('error', () => client.destroy())
    client.on('close', () => request.destroy())
    client.on('error', () => request.destroy())
    request.end()
  })
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'))
  server.shutdown = () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)) }
  return server
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration()
  const server = createGateway(config)
  server.listen(config.port, config.host, () => console.log(`ABS frontend ${config.revision} listening on loopback port ${config.port}`))
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await server.shutdown(); process.exit(0) })
}
