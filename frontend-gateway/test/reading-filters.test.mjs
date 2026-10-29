import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../../client/lib/reading-filters.js', import.meta.url), 'utf8')
const { filterReadingBooks, deviceDownloadState, ownershipLabel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const books = [
  { id: 'a', status: 'reading', ownership: 'owned' },
  { id: 'b', status: 'reading', ownership: 'unowned', libraryItemId: 'shared-copy' },
  { id: 'c', status: 'finished', ownership: 'owned' },
  { id: 'd', status: 'to-read' },
  { id: 'e', status: 'reading', ownership: 'owned', deleted: true }
]
test('combined filters intersect independent state, ownership and device availability', () => {
  const filter = { statuses: ['reading'], ownership: 'owned', downloads: 'unverified' }
  assert.deepEqual(filterReadingBooks(books, filter).map(b => b.id), ['a'])
  assert.deepEqual(filterReadingBooks(books, { ...filter, showRemoved: true }).map(b => b.id), ['a', 'e'])
  assert.deepEqual(filterReadingBooks(books, { ...filter, ownership: 'unowned' }).map(b => b.id), ['b'])
  assert.deepEqual(filterReadingBooks(books, { ...filter, downloads: 'downloaded' }), [])
  assert.deepEqual(filterReadingBooks(books, { ...filter, statuses: [] }), [])
  assert.deepEqual(filterReadingBooks(books, { statuses: ['to-read'], ownership: 'unspecified' }).map(b => b.id), ['d'])
  assert.equal(ownershipLabel(books[1]), 'Unowned'); assert.equal(ownershipLabel(books[3]), 'Ownership not specified')
})
test('server copies, another device, stale records and missing files never claim downloaded', () => {
  for (const metadata of [{ libraryItemId: 'server-file' }, { downloaded: true }, { downloaded: true, deviceId: 'other-device' }, { downloaded: true, localPath: '/missing/file' }, { downloadedAt: '2020-01-01' }, {}]) {
    assert.equal(deviceDownloadState(metadata), 'unverified')
    assert.deepEqual(filterReadingBooks([{ status: 'reading', ownership: 'owned', ...metadata }], { statuses: ['reading'], ownership: 'owned', downloads: 'downloaded' }), [])
  }
})
