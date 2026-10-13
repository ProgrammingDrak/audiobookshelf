// Host-owned Linux/systemd-user adapter. Never executed by GitHub Actions.
import { readFile, mkdir, readlink, symlink, rename, unlink, mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

const repository = 'ProgrammingDrak/audiobookshelf'
const service = 'abs-frontend.service'

async function switchLink(root, target) {
  const temp = path.join(root, `current-${process.pid}.tmp`)
  await symlink(target, temp)
  try { await rename(temp, path.join(root, 'current')) } finally { await unlink(temp).catch(() => {}) }
}

export async function activate(root, revision, { restart, health }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid revision')
  const previous = await readlink(path.join(root, 'current'))
  if (!/^releases\/[a-f0-9]{40}$/.test(previous)) throw new Error('Invalid current release link')
  if (previous === `releases/${revision}`) return false
  const metadata = JSON.parse(await readFile(path.join(root, 'releases', revision, 'release.json'), 'utf8'))
  if (metadata.revision !== revision) throw new Error('Release revision mismatch')
  await switchLink(root, `releases/${revision}`)
  try {
    await restart()
    if (!(await health(revision))) throw new Error('New release failed readiness')
  } catch (error) {
    await switchLink(root, previous)
    await restart()
    if (!(await health(previous.slice('releases/'.length)))) throw new Error('Rollback restored previous release but service is unhealthy')
    throw error
  }
  return true
}

async function download(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'abs-frontend-host-pull' } })
  if (!response.ok) throw new Error(`Release download failed (${response.status})`)
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Release download too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function validateArchive(listing, verbose) {
  for (const entry of listing.trim().split('\n')) {
    if (!/^(client\/|frontend-gateway\/|LICENSE$|release\.json$|source\.tar\.gz$)/.test(entry) || entry.split('/').some(part => part === '..') || entry.includes('\\')) throw new Error('Unsafe archive path')
  }
  if (verbose.trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error('Archive links/special files are not permitted')
}

export async function checkHealth(port, host, sha) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: '/readyz', headers: { host }, timeout: 3000 }, response => {
          let body = ''; response.on('data', b => body += b); response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(body).revision === sha) } catch { resolve(false) } })
        })
        request.on('error', reject); request.on('timeout', () => request.destroy(new Error('timeout')))
      })
      if (result) return true
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function main() {
  if (process.platform !== 'linux') throw new Error('This adapter requires a confirmed Linux/systemd-user host')
  const root = path.resolve(process.env.ABS_FRONTEND_HOME || '')
  if (!process.env.ABS_FRONTEND_HOME) throw new Error('ABS_FRONTEND_HOME required')
  const origin = new URL(process.env.PUBLIC_ORIGIN)
  const port = Number(process.env.PORT || 13379)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  const lock = path.join(root, '.update-lock')
  await mkdir(lock) // concurrent checks fail closed; never remove someone else's lock
  let temporary
  try {
    const release = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases/latest`, 2_000_000)).toString())
    const match = /^frontend-([a-f0-9]{40})$/.exec(release.tag_name)
    if (!match || release.draft || release.prerelease) throw new Error('Unexpected release channel')
    const revision = match[1]
    if (await readlink(path.join(root, 'current')) === `releases/${revision}`) return
    const asset = name => {
      const url = release.assets?.find(a => a.name === name)?.browser_download_url
      if (url !== `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`) throw new Error('Unexpected release asset URL')
      return url
    }
    const checksum = (await download(asset('SHA256SUMS'), 1024)).toString()
    const expected = /^([a-f0-9]{64})  abs-frontend\.tar\.gz\n$/.exec(checksum)?.[1]
    if (!expected) throw new Error('Invalid checksum manifest')
    const bundle = await download(asset('abs-frontend.tar.gz'), 250_000_000)
    if (createHash('sha256').update(bundle).digest('hex') !== expected) throw new Error('Checksum mismatch')
    await mkdir(path.join(root, 'releases'), { recursive: true })
    temporary = await mkdtemp(path.join(root, 'releases', '.staging-'))
    const archive = path.join(temporary, 'bundle.tar.gz')
    await writeFile(archive, bundle)
    const tar = args => execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 10_000_000 })
    validateArchive(tar(['-tzf', archive]), tar(['-tvzf', archive]))
    const extracted = path.join(temporary, 'extracted')
    await mkdir(extracted)
    tar(['-xzf', archive, '-C', extracted, '--no-same-owner', '--no-same-permissions'])
    const metadata = JSON.parse(await readFile(path.join(extracted, 'release.json'), 'utf8'))
    if (metadata.revision !== revision || metadata.source !== `https://github.com/${repository}/tree/${revision}`) throw new Error('Release metadata mismatch')
    await stat(path.join(extracted, 'client/dist/index.html'))
    await stat(path.join(extracted, 'frontend-gateway/server.mjs'))
    const target = path.join(root, 'releases', revision)
    try { await stat(target); throw new Error('Release directory already exists; inspect before retrying') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await rename(extracted, target)
    const changed = await activate(root, revision, {
      restart: () => execFileSync('systemctl', ['--user', 'restart', service], { stdio: 'inherit' }),
      health: sha => checkHealth(port, origin.host, sha)
    })
    console.log(changed ? `Activated ${revision}` : 'Already current')
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
