import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../client/package.json', import.meta.url))
const { io } = require('socket.io-client')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const image = process.env.ABS_DOCKER_TEST_IMAGE
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10_000_000 }).trim()
const baseImage = 'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'

test('Docker runtime and real Compose rollout preserve login/audio/socket/progress and restore a failed image', { skip: !image, timeout: 180_000 }, async t => {
  const endpoint = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
  assert.match(endpoint, /^unix:\/\//, 'Container tests require a local Docker context')
  const suffix = randomUUID().slice(0, 8)
  const network = 'abs-frontend-test-' + suffix, mock = network + '-mock', app = network + '-app', project = 'abs-frontend-' + suffix
  const stage = await mkdtemp(path.join(os.tmpdir(), 'abs-docker-fixture-'))
  const home = path.join(stage, 'host')
  const fixtureImages = []
  let socket
  t.after(async () => {
    socket?.close()
    for (const name of [app, mock]) try { docker('rm', '-f', name) } catch {}
    try { const ids = docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project).split('\n').filter(Boolean); if (ids.length) docker('rm', '-f', ...ids) } catch {}
    try { docker('network', 'rm', network) } catch {}
    for (const reference of fixtureImages) try { docker('image', 'rm', reference) } catch {}
    await rm(stage, { recursive: true, force: true })
  })
  await chmod(stage, 0o755)
  await mkdir(path.join(stage, 'fixture/frontend-gateway/test'), { recursive: true })
  await mkdir(path.join(stage, 'fixture/client'), { recursive: true })
  await mkdir(path.join(stage, 'fixture/client/node_modules'))
  await mkdir(home)
  for (const name of ['mock-backend.mjs', 'docker-mock-server.mjs']) await cp(path.join(repo, 'frontend-gateway/test', name), path.join(stage, 'fixture/frontend-gateway/test', name))
  await cp(path.join(repo, 'client/package.json'), path.join(stage, 'fixture/client/package.json'))
  docker('network', 'create', network)
  docker('run', '-d', '--name', mock, '--network', network, '--network-alias', 'mock', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,src=${path.join(stage, 'fixture')},dst=/fixture,readonly`, '--mount', `type=bind,src=${path.join(repo, 'client/node_modules')},dst=/fixture/client/node_modules,readonly`, baseImage, 'node', '/fixture/frontend-gateway/test/docker-mock-server.mjs')
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const revision = JSON.parse(docker('image', 'inspect', image))[0].Config.Labels['org.opencontainers.image.revision']
  docker('run', '-d', '--name', app, '--network', network, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '256m', '--cpus', '1', '--init', '-p', `127.0.0.1:${port}:8080`, '-e', 'ABS_UPSTREAM=http://mock:13380', '-e', `PUBLIC_ORIGIN=${origin}`, '-e', 'EXPECTED_BACKEND_VERSION=2.37.1', '--health-interval', '1s', '--health-start-period', '0s', '--health-retries', '1', image)
  for (let attempt = 0; attempt < 50; attempt++) {
    try { const response = await fetch(origin + '/readyz'); if (response.status === 200) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const ready = await (await fetch(origin + '/readyz')).json()
  assert.equal(ready.revision, revision); assert.equal(ready.ok, true)
  const inspect = JSON.parse(docker('inspect', app))[0]
  assert.equal(inspect.Config.User, '1000:1000'); assert.equal(inspect.HostConfig.ReadonlyRootfs, true); assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']); assert.equal(inspect.Mounts.length, 0)
  assert.equal(inspect.HostConfig.PortBindings['8080/tcp'][0].HostIp, '127.0.0.1')
  const protections = JSON.parse(docker('exec', app, 'node', '-e', `const fs=require('fs');let readOnly=false;try{fs.writeFileSync('/app/write-probe','x')}catch(e){readOnly=e.code==='EROFS'}console.log(JSON.stringify({uid:process.getuid(),readOnly,socket:fs.existsSync('/var/run/docker.sock'),npm:fs.existsSync('/usr/local/bin/npm')}))`))
  assert.deepEqual(protections, { uid: 1000, readOnly: true, socket: false, npm: false })
  const page = await (await fetch(origin + '/audiobookshelf/login')).text()
  assert.match(page, /Audiobookshelf/)
  const script = page.match(/<script[^>]+src="([^"]+)"/)[1]
  assert.equal((await fetch(new URL(script, origin))).status, 200)
  const login = await fetch(origin + '/audiobookshelf/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo' }) })
  const firstToken = (await login.json()).user.accessToken
  const refresh = await fetch(origin + '/audiobookshelf/auth/refresh', { method: 'POST', headers: { cookie: login.headers.getSetCookie()[0].split(';')[0] } })
  const token = (await refresh.json()).user.accessToken
  assert.notEqual(token, firstToken); assert.match(refresh.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax; Secure/)
  const post = (url, body) => fetch(origin + '/audiobookshelf' + url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const session = await (await post('/api/items/demo-book/play', {})).json()
  const track = origin + `/audiobookshelf/public/session/${session.id}/track/0`
  const audio = await fetch(track); const full = Buffer.from(await audio.arrayBuffer()); assert.equal(full.subarray(0, 4).toString(), 'RIFF')
  const seek = await fetch(track, { headers: { range: 'bytes=8000-8099' } }); assert.equal(seek.status, 206); assert.deepEqual(Buffer.from(await seek.arrayBuffer()), full.subarray(8000, 8100))
  socket = io(origin, { path: '/audiobookshelf/socket.io', transports: ['websocket'], extraHeaders: { origin }, reconnection: false })
  await once(socket, 'connect'); const initialized = once(socket, 'init'); socket.emit('auth', token); await initialized
  const broadcast = once(socket, 'user_item_progress_updated')
  assert.equal((await post('/api/session/demo-session/sync', { currentTime: 27.5, timeListened: 4 })).status, 200)
  assert.equal((await broadcast)[0].data.currentTime, 27.5)
  assert.equal((await (await post('/api/items/demo-book/play', {})).json()).currentTime, 27.5)
  assert.equal((await fetch(origin + '/audiobookshelf/api/me', { headers: { origin: 'https://evil.invalid' } })).status, 400)
  socket.close(); docker('rm', '-f', app)

  const original = await readFile(path.join(repo, 'frontend-gateway/docker/compose.yaml'), 'utf8')
  const compose = original.replace('    logging:', '    healthcheck:\n      interval: 1s\n      timeout: 4s\n      start_period: 0s\n      retries: 1\n    logging:') + `\nnetworks:\n  default:\n    external: true\n    name: ${network}\n`
  await writeFile(path.join(home, 'compose.yaml'), compose)
  await writeFile(path.join(home, 'runtime.env'), `ABS_FRONTEND_IMAGE=${image}\nABS_UPSTREAM=http://mock:13380\nPUBLIC_ORIGIN=${origin}\nEXPECTED_BACKEND_VERSION=2.37.1\nABS_FRONTEND_PORT=${port}\n`, { mode: 0o600 })
  const records = [{ revision, image_id: JSON.parse(docker('image', 'inspect', image))[0].Id }]
  for (const [rev, version] of [['c'.repeat(40), '2.37.1'], ['d'.repeat(40), '99.0.0']]) {
    const context = path.join(stage, 'image-' + rev[0])
    await cp(path.join(repo, 'frontend-gateway/out/bundle'), context, { recursive: true })
    const metadata = JSON.parse(await readFile(path.join(context, 'release.json'), 'utf8')); metadata.revision = rev; metadata.clientVersion = version
    await writeFile(path.join(context, 'release.json'), JSON.stringify(metadata))
    const reference = `abs-frontend:fixture-${suffix}-${rev[0]}`; fixtureImages.push(reference)
    docker('build', '--build-arg', `BUILD_REVISION=${rev}`, '-t', reference, '-f', path.join(repo, 'frontend-gateway/docker/Dockerfile'), context)
    records.push({ revision: rev, image_id: JSON.parse(docker('image', 'inspect', reference))[0].Id })
  }
  const arch = JSON.parse(docker('image', 'inspect', image))[0].Architecture
  const candidates = records.map(record => ({ ...record, architecture: arch, archive: `abs-frontend-${arch}.docker.tar.gz`, archive_sha256: 'e'.repeat(64) }))
  await writeFile(path.join(stage, 'records.json'), JSON.stringify(candidates))
  const python = `import importlib.util,json,pathlib\nspec=importlib.util.spec_from_file_location('u',${JSON.stringify(path.join(repo, 'frontend-gateway/docker/update.py'))})\nu=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)\nhome=pathlib.Path(${JSON.stringify(home)})\nrecords=json.loads(pathlib.Path(${JSON.stringify(path.join(stage, 'records.json'))}).read_text())\ndocker=u.Docker(home,project=${JSON.stringify(project)},wait_seconds=8)\nassert u.rollout(home,records[0],docker)\nassert u.rollout(home,records[1],docker)\nbefore=docker.compose(['ps','-q','frontend'],records[1]['image_id'])\nassert not u.rollout(home,records[1],docker)\nassert before==docker.compose(['ps','-q','frontend'],records[1]['image_id'])\ntry:\n u.rollout(home,records[2],docker)\n raise AssertionError('unhealthy image was accepted')\nexcept RuntimeError:\n pass\nassert json.loads((home/'current.json').read_text())==records[1]\nassert docker.health(records[1])\nassert (home/'blocked'/(records[2]['revision']+'.json')).exists()\nprint('Real Compose bootstrap, healthy upgrade, no-op and failed-image rollback passed')\n`
  const evidence = execFileSync(process.env.PYTHON_BINARY || 'python3', ['-c', python], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })
  assert.match(evidence, /rollback passed/)
  console.log(`Container platform linux/${arch}: non-root/read-only/capability/socket checks, compiled UI, login/refresh/audio/seek/socket/progress and ${evidence.trim()}`)
})
