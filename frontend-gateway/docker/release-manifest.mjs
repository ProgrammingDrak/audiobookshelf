import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const [directory, revision] = process.argv.slice(2)
if (!directory || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Usage: release-manifest.mjs DIRECTORY REVISION')
const images = {}
for (const arch of ['amd64', 'arm64']) {
  const record = JSON.parse(await readFile(path.join(directory, `docker-image-${arch}.json`), 'utf8'))
  if (record.revision !== revision || record.architecture !== arch || !/^sha256:[a-f0-9]{64}$/.test(record.image_id) || !/^[a-f0-9]{64}$/.test(record.archive_sha256) || record.archive !== `abs-frontend-${arch}.docker.tar.gz`) throw new Error('Platform descriptor mismatch')
  images[arch] = record
}
await writeFile(path.join(directory, 'docker-release.json'), JSON.stringify({ revision, source: `https://github.com/ProgrammingDrak/audiobookshelf/tree/${revision}`, images }, null, 2) + '\n')
