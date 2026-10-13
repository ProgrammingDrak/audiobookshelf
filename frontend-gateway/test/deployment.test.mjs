import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readlink, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { activate, validateArchive } from '../deployment/update.mjs'
const old = 'a'.repeat(40), next = 'b'.repeat(40)
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abs-update-test-'))
  for (const revision of [old, next]) { const dir = path.join(root, 'releases', revision); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'release.json'), JSON.stringify({ revision })) }
  await symlink(`releases/${old}`, path.join(root, 'current'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('activation selects exact revision only after readiness; same revision is a no-op', async t => {
  const root = await fixture(t), checks = []
  const operations = { restart: async () => checks.push(await readlink(path.join(root, 'current'))), health: async sha => sha === next }
  assert.equal(await activate(root, next, operations), true)
  assert.equal(await readlink(path.join(root, 'current')), `releases/${next}`)
  assert.deepEqual(checks, [`releases/${next}`])
  assert.equal(await activate(root, next, operations), false)
  assert.equal(checks.length, 1)
})
test('failed health automatically restores and restarts previous release', async t => {
  const root = await fixture(t), checks = []
  await assert.rejects(activate(root, next, { restart: async () => checks.push(await readlink(path.join(root, 'current'))), health: async sha => sha === old }), /failed readiness/)
  assert.equal(await readlink(path.join(root, 'current')), `releases/${old}`)
  assert.deepEqual(checks, [`releases/${next}`, `releases/${old}`])
})
test('failed restart restores previous release and reports failed rollback health', async t => {
  const root = await fixture(t); let attempts = 0
  await assert.rejects(activate(root, next, { restart: async () => { if (++attempts === 1) throw new Error('restart failure') }, health: async () => false }), /Rollback restored/)
  assert.equal(await readlink(path.join(root, 'current')), `releases/${old}`); assert.equal(attempts, 2)
})
test('mismatched release metadata refuses activation before restart', async t => {
  const root = await fixture(t)
  await writeFile(path.join(root, 'releases', next, 'release.json'), JSON.stringify({ revision: old }))
  await assert.rejects(activate(root, next, { restart: () => assert.fail('must not restart'), health: () => true }), /mismatch/)
  assert.equal(await readlink(path.join(root, 'current')), `releases/${old}`)
})
test('archive validation refuses traversal and links but accepts regular bundle entries', () => {
  validateArchive('client/dist/index.html\nfrontend-gateway/server.mjs\nLICENSE\nrelease.json\nsource.tar.gz\n', '-rw-r--r-- x index\ndrwxr-xr-x x dir\n')
  assert.throws(() => validateArchive('client/../../escape\n', '-rw-r--r-- x\n'), /Unsafe archive/)
  assert.throws(() => validateArchive('/tmp/escape\n', '-rw-r--r-- x\n'), /Unsafe archive/)
  assert.throws(() => validateArchive('client/link\n', 'lrwxrwxrwx x link\n'), /links/)
})
