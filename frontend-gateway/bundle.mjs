import { execFileSync } from 'node:child_process'
import { cp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
if (git('status', '--porcelain')) throw new Error('Commit source changes before producing a versioned bundle')
const revision = git('rev-parse', 'HEAD')
await stat(path.join(repo, 'client/dist/index.html'))
const out = path.join(repo, 'frontend-gateway/out')
const staging = path.join(out, 'bundle')
await rm(staging, { recursive: true, force: true })
await mkdir(path.join(staging, 'client'), { recursive: true })
await cp(path.join(repo, 'client/dist'), path.join(staging, 'client/dist'), { recursive: true })
await mkdir(path.join(staging, 'frontend-gateway'), { recursive: true })
for (const name of ['server.mjs', 'package.json', 'README.md', 'HOSTING-PROPOSAL.md', 'deployment', 'docker']) await cp(path.join(repo, 'frontend-gateway', name), path.join(staging, 'frontend-gateway', name), { recursive: true })
await cp(path.join(repo, 'LICENSE'), path.join(staging, 'LICENSE'))
const metadata = { revision, source: `https://github.com/ProgrammingDrak/audiobookshelf/tree/${revision}`, clientVersion: JSON.parse(execFileSync('git', ['show', `${revision}:client/package.json`], { cwd: repo, encoding: 'utf8' })).version }
await writeFile(path.join(staging, 'release.json'), JSON.stringify(metadata, null, 2) + '\n')
execFileSync('git', ['archive', '--format=tar.gz', `--output=${path.join(staging, 'source.tar.gz')}`, revision], { cwd: repo })
const name = 'abs-frontend.tar.gz'
execFileSync('tar', ['-czf', path.join(out, name), '-C', staging, 'client', 'frontend-gateway', 'LICENSE', 'release.json', 'source.tar.gz'])
const hash = createHash('sha256')
for await (const chunk of createReadStream(path.join(out, name))) hash.update(chunk)
await writeFile(path.join(out, 'SHA256SUMS'), `${hash.digest('hex')}  ${name}\n`)
console.log(`Built ${name} for ${revision}; complete corresponding source included`)
