import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import path from 'node:path'

const [reference, output, arch] = process.argv.slice(2)
if (!reference || !output || !['amd64', 'arm64'].includes(arch)) throw new Error('Usage: image-artifact.mjs IMAGE OUTPUT_DIRECTORY amd64|arm64')
const directory = path.resolve(output)
await mkdir(directory, { recursive: true })
const metadata = JSON.parse(await readFile(path.join(directory, 'bundle/release.json'), 'utf8'))
const image = JSON.parse(execFileSync('docker', ['image', 'inspect', reference], { encoding: 'utf8' }))[0]
if (image.Os !== 'linux' || image.Architecture !== arch || image.Config.User !== 'node' || image.Config.Labels?.['org.opencontainers.image.revision'] !== metadata.revision || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('Image platform/user/revision mismatch')
const archive = `abs-frontend-${arch}.docker.tar.gz`
const saver = spawn('docker', ['image', 'save', image.Id], { stdio: ['ignore', 'pipe', 'inherit'] })
const exited = once(saver, 'exit')
await pipeline(saver.stdout, createGzip({ level: 6 }), createWriteStream(path.join(directory, archive)))
const [code] = await exited
if (code !== 0) throw new Error('Docker image export failed')
const hash = createHash('sha256')
for await (const chunk of createReadStream(path.join(directory, archive))) hash.update(chunk)
const record = { revision: metadata.revision, architecture: arch, image_id: image.Id, archive, archive_sha256: hash.digest('hex'), archive_bytes: (await stat(path.join(directory, archive))).size }
await writeFile(path.join(directory, `docker-image-${arch}.json`), JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record))
