import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { configuration, createGateway, base } from '../server.mjs'
import { createMockBackend } from './mock-backend.mjs'
const require = createRequire(new URL('../../client/package.json', import.meta.url))
const { io } = require('socket.io-client')
const axios = require('axios')
const sourceModule = async name => import('data:text/javascript;base64,' + (await readFile(new URL('../../client/' + name, import.meta.url))).toString('base64'))

async function fixture(t, prefix = '') {
  const backend = createMockBackend(prefix)
  backend.server.listen(0, '127.0.0.1'); await once(backend.server, 'listening')
  const dist = await mkdtemp(path.join(os.tmpdir(), 'abs-gateway-test-'))
  await writeFile(path.join(dist, 'index.html'), '<html>synthetic-shell</html>')
  await writeFile(path.join(dist, 'app.js'), 'synthetic-asset')
  const config = configuration({ ABS_UPSTREAM: `http://127.0.0.1:${backend.server.address().port}${prefix}`, CLIENT_DIST: dist, EXPECTED_BACKEND_VERSION: '2.37.1', BUILD_REVISION: 'test-revision' })
  const gateway = createGateway(config)
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
  config.origin.port = String(gateway.address().port)
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ hostname: '127.0.0.1', port: gateway.address().port, path: url, method, headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => {
        const buffer = Buffer.concat(chunks), text = buffer.toString()
        let json; try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buffer, text, json })
      }); res.on('error', reject)
    })
    req.on('error', reject); req.end(raw)
  })
  t.after(async () => { await gateway.shutdown(); await backend.close(); await rm(dist, { recursive: true, force: true }) })
  return { backend, request, config, gateway, origin: config.origin.origin, dist }
}

test('serves SPA navigation/assets; API errors never become HTML', async t => {
  const { request } = await fixture(t)
  assert.equal((await request('/')).headers.location, base + '/')
  assert.match((await request(base + '/login')).text, /synthetic-shell/)
  assert.match((await request(base + '/library/id')).text, /synthetic-shell/)
  assert.equal((await request(base + '/app.js')).text, 'synthetic-asset')
  assert.equal((await request(base + '/missing.js')).status, 404)
  const error = await request(base + '/api/unauthorized')
  assert.equal(error.status, 401); assert.deepEqual(error.json, { error: 'expired' })
})

test('fixed-target guard rejects foreign origins, hosts, paths, and setup', async t => {
  const { backend, request, dist } = await fixture(t)
  for (const [url, headers] of [[base + '/api/me', { origin: 'https://evil.invalid' }], [base + '/api/me', { host: 'evil.invalid' }], [base + '/api/me', { 'sec-fetch-site': 'cross-site' }], ['http://evil.invalid/api/me', {}], ['//evil.invalid/api/me', {}], [base + '/%2e%2e/LICENSE', {}], [base + '/api%2fme', {}], ['/outside/api/me', {}]]) assert.equal((await request(url, { headers })).status, 400)
  assert.equal((await request(base + '/init', { method: 'POST', body: {} })).status, 403)
  assert.equal(backend.requests.length, 0)
  await symlink('/etc/passwd', path.join(dist, 'escape.txt'))
  assert.equal((await request(base + '/escape.txt')).status, 403)
})

test('login, refresh rotation, secure host-only cookies, redirects, and logout', async t => {
  const { request, backend } = await fixture(t, base)
  const bad = await request(base + '/login', { method: 'POST', body: { username: 'demo', password: 'bad' } })
  assert.equal(bad.status, 401)
  const login = await request(base + '/login', { method: 'POST', body: { username: 'demo', password: 'demo' }, headers: { 'x-forwarded-proto': 'https,attacker', 'x-forwarded-for': 'attacker' } })
  assert.equal(login.json.user.accessToken, 'demo-access-1')
  const seen = backend.requests.at(-1)
  assert.equal(seen.url, base + '/login'); assert.equal(seen.headers['x-forwarded-proto'], 'http'); assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1')
  const refreshed = await request(base + '/auth/refresh', { method: 'POST', headers: { cookie: login.headers['set-cookie'][0].split(';')[0] } })
  assert.equal(refreshed.json.user.accessToken, 'demo-access-2')
  assert.equal(refreshed.headers['set-cookie'].length, 2)
  assert.match(refreshed.headers['set-cookie'][0], /HttpOnly; SameSite=Lax; Secure/)
  assert.doesNotMatch(refreshed.headers['set-cookie'][0], /Domain=/i)
  const authorized = await request(base + '/api/authorize', { method: 'POST', headers: { authorization: 'Bearer demo-access-2' } })
  assert.equal(authorized.json.user.id, 'demo-user')
  assert.equal((await request(base + '/auth/redirect')).headers.location, base + '/login?synthetic=1')
  assert.match((await request(base + '/logout', { method: 'POST' })).headers['set-cookie'][0], /Max-Age=0/)
})

test('direct play, range seek, HEAD, unsatisfiable ranges, and HLS preserve bytes', async t => {
  const { request, backend } = await fixture(t)
  const session = await request(base + '/api/items/demo-book/play', { method: 'POST', headers: { authorization: 'Bearer demo-access-1' }, body: {} })
  assert.equal(session.json.audioTracks.length, 1)
  const { default: AudioTrack } = await sourceModule('players/AudioTrack.js')
  const track = new AudioTrack(session.json.audioTracks[0], session.json.id, base)
  const full = await request(track.relativeContentUrl)
  assert.equal(full.status, 200); assert.deepEqual(full.buffer, backend.bytes)
  const seek = await request(track.relativeContentUrl + '?token=synthetic', { headers: { range: 'bytes=8000-8099' } })
  assert.equal(seek.status, 206); assert.equal(seek.headers['content-range'], `bytes 8000-8099/${backend.bytes.length}`); assert.deepEqual(seek.buffer, backend.bytes.subarray(8000, 8100))
  assert.match(backend.requests.at(-1).url, /\?token=synthetic$/)
  const head = await request(track.relativeContentUrl, { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.buffer.length, 0); assert.equal(Number(head.headers['content-length']), backend.bytes.length)
  assert.equal((await request(track.relativeContentUrl, { headers: { range: 'bytes=999999999-' } })).status, 416)
  const hls = new AudioTrack({ contentUrl: '/hls/demo-stream/master.m3u8' }, session.json.id, base)
  assert.match((await request(hls.relativeContentUrl)).text, /segment-1.ts/)
  assert.equal((await request(base + '/hls/demo-stream/segment-1.ts')).text, 'synthetic-segment')
})

test('real ABS axios plugin refreshes expired token and reauthenticates socket', async t => {
  const { backend, origin } = await fixture(t)
  const { default: plugin } = await sourceModule('plugins/axios.js')
  const { actions } = await sourceModule('store/user.js')
  const client = axios.create({ baseURL: origin + base, proxy: false })
  let cookie = '', token = 'demo-access-1', refreshedEvent
  client.interceptors.request.use(config => { config.headers.Cookie = cookie; return config })
  client.interceptors.response.use(response => { if (response.headers['set-cookie']) cookie = response.headers['set-cookie'][0].split(';')[0]; return response })
  client.onRequest = fn => client.interceptors.request.use(config => fn(config) || config)
  client.onError = fn => client.interceptors.response.use(undefined, fn)
  client.$post = (...args) => client.post(...args).then(response => response.data)
  const socket = io(origin, { path: base + '/socket.io', transports: ['websocket'], extraHeaders: { origin }, reconnection: false })
  t.after(() => socket.close())
  await once(socket, 'connect')
  socket.emit('auth', token); await once(socket, 'init')
  const store = {
    getters: { get 'user/getToken'() { return token } },
    commit(name, value) { if (name === 'setAccessToken' || name === 'user/setAccessToken') token = value },
    dispatch(name) { assert.equal(name, 'user/refreshToken'); return actions.refreshToken.call({ $axios: client, $eventBus: { $emit(event, value) { refreshedEvent = [event, value]; socket.emit('auth', value) } } }, { commit: this.commit }) }
  }
  plugin({ $axios: client, store, app: { router: { push() { assert.fail('Unexpected login redirect') } } } })
  await client.$post('/login', { username: 'demo', password: 'demo' })
  backend.expireAccess()
  const reauthenticated = once(socket, 'init')
  const response = await client.$post('/api/authorize')
  await reauthenticated
  assert.equal(response.user.id, 'demo-user'); assert.equal(token, 'demo-access-2'); assert.deepEqual(refreshedEvent, ['token_refreshed', 'demo-access-2'])
  assert.equal(backend.requests.filter(r => r.url === '/auth/refresh').length, 1)
})

test('progress writes reach the one backend and broadcast to a second socket', async t => {
  const { request, backend, origin } = await fixture(t, base)
  const sockets = [0, 1].map(() => io(origin, { path: base + '/socket.io', transports: ['websocket'], extraHeaders: { origin }, reconnection: false }))
  t.after(() => sockets.forEach(socket => socket.close()))
  await Promise.all(sockets.map(socket => once(socket, 'connect')))
  await Promise.all(sockets.map(async socket => { const init = once(socket, 'init'); socket.emit('auth', 'demo-access-1'); await init }))
  const broadcasts = sockets.map(socket => once(socket, 'user_item_progress_updated'))
  const response = await request(base + '/api/session/demo-session/sync', { method: 'POST', body: { currentTime: 23.5, timeListened: 4, duration: 60 }, headers: { authorization: 'Bearer demo-access-1' } })
  assert.equal(response.status, 200); assert.equal(backend.currentTime, 23.5)
  const { mutations } = await sourceModule('store/user.js')
  for (const [payload] of await Promise.all(broadcasts)) {
    assert.equal(payload.data.currentTime, 23.5)
    const state = { user: { mediaProgress: [] } }; mutations.updateMediaProgress(state, payload)
    assert.equal(state.user.mediaProgress[0].currentTime, 23.5)
  }
  const resumed = await request(base + '/api/items/demo-book/play', { method: 'POST', body: {}, headers: { authorization: 'Bearer demo-access-1' } })
  assert.equal(resumed.json.currentTime, 23.5)
})

test('readiness fails on wrong/uninitialized backend and reports versioned build', async t => {
  const { request, backend, config } = await fixture(t)
  assert.deepEqual((await request('/readyz')).json, { ok: true, revision: 'test-revision', backendVersion: '2.37.1' })
  backend.version = 'older'; assert.equal((await request('/readyz')).status, 503)
  backend.version = '2.37.1'; backend.initialized = false; assert.equal((await request('/readyz')).status, 503)
  backend.initialized = true; config.expectedVersion = undefined; assert.equal((await request('/readyz')).json.error, 'backend_version_unconfirmed')
  assert.equal((await request('/healthz')).status, 200)
})

test('configuration refuses non-loopback listener and embedded upstream credentials', () => {
  assert.throws(() => configuration({ HOST: '0.0.0.0' }), /loopback/)
  assert.throws(() => configuration({ ABS_UPSTREAM: 'http://user:secret@localhost' }), /credential-free/)
  assert.throws(() => configuration({ ABS_UPSTREAM: 'http://localhost/other' }), /credential-free/)
})
