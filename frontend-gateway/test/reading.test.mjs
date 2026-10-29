import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openReadingStore } from '../reading-store.mjs'
const add = (id = 'book-one', title = 'Between Two Fires') => ({ opId: 'operation-' + id, id, revision: 0, action: 'save', book: { title, author: 'Christopher Buehlman', status: 'to-read' } })
test('persists unowned books, deduplicates normalized metadata and isolates accounts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reading-')); const file = path.join(dir, 'shelf.sqlite')
  let s = openReadingStore(file)
  try {
    const a = s.apply('alice', add()); assert.equal(a.book.libraryItemId, '')
    assert.equal(s.apply('alice', add()).book.revision, 1)
    assert.equal(s.apply('alice', add('book-two', '  BETWEEN   TWO FIRES ')).duplicate, true)
    assert.equal(s.list('alice').length, 1); assert.equal(s.list('bob').length, 0)
    s.apply('bob', add()); s.close(); s = openReadingStore(file)
    assert.equal(s.list('alice')[0].title, 'Between Two Fires'); assert.equal(s.list('bob').length, 1)
  } finally { s.close(); await rm(dir, { recursive: true, force: true }) }
})
test('rejects stale edits, retains tombstones and restores only with current revision', () => {
  const s = openReadingStore(':memory:')
  try {
    s.apply('alice', add())
    const removed = s.apply('alice', { opId: 'operation-delete', id: 'book-one', action: 'remove', revision: 1 })
    assert.equal(removed.book.deleted, true)
    assert.throws(() => s.apply('alice', { ...add(), opId: 'stale-operation', revision: 1 }), { status: 409 })
    assert.throws(() => s.apply('alice', { ...add(), opId: 'new-operation', revision: 2 }), { status: 409 })
    assert.equal(s.apply('alice', { opId: 'operation-restore', id: 'book-one', action: 'restore', revision: 2 }).book.deleted, false)
    assert.equal(s.list('bob').length, 0)
  } finally { s.close() }
})
test('validates fields and rolls back a duplicate edit without losing either book', () => {
  const s = openReadingStore(':memory:')
  try {
    s.apply('a', add()); s.apply('a', add('book-two', 'Other title'))
    assert.throws(() => s.apply('a', { ...add('book-two'), opId: 'edit-duplicate', revision: 1 }), { status: 409 })
    assert.equal(s.list('a').length, 2)
    assert.throws(() => s.apply('a', { ...add('book-bad'), book: { title: 'X', status: 'bad' } }), { status: 400 })
  } finally { s.close() }
})

test('gateway authenticates reading requests, isolates users and rejects old-account writes', async () => {
  const { createServer } = await import('node:http')
  const { createGateway, configuration } = await import('../server.mjs')
  const backend = createServer((req, res) => { const id = { 'Bearer alice': 'alice', 'Bearer bob': 'bob' }[req.headers.authorization]; res.writeHead(id ? 200 : 401, { 'content-type': 'application/json' }); res.end(JSON.stringify(id ? { id } : {})) })
  await new Promise(r => backend.listen(0, '127.0.0.1', r))
  const config = configuration({ ABS_UPSTREAM: `http://127.0.0.1:${backend.address().port}`, READING_DB: ':memory:' })
  const gateway = createGateway(config); await new Promise(r => gateway.listen(0, '127.0.0.1', r)); config.origin.port = String(gateway.address().port)
  const url = config.origin.origin + '/audiobookshelf/api/quietshelf/reading'
  const call = (user, body) => fetch(url, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + user, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    assert.equal((await call('bad')).status, 401)
    assert.equal((await call('alice', { ...add(), userId: 'bob' })).status, 409)
    assert.equal((await (await call('alice')).json()).books.length, 0)
    assert.equal((await call('alice', { ...add(), userId: 'alice' })).status, 200)
    assert.equal((await (await call('alice')).json()).books.length, 1)
    assert.equal((await (await call('bob')).json()).books.length, 0)
    config.readingDb = null
    assert.equal((await call('alice')).status, 503)
  } finally { await gateway.shutdown(); await new Promise(r => backend.close(r)) }
})

test('ownership is explicit, independent, preserved by older edits and duplicate adds', () => {
  const s = openReadingStore(':memory:')
  try {
    const original = s.apply('a', { ...add(), book: { ...add().book, status: 'reading', ownership: 'owned', libraryItemId: 'shared-book' } }).book
    assert.equal(original.ownership, 'owned'); assert.equal(original.status, 'reading')
    const duplicate = s.apply('a', { ...add('second-book'), book: { ...add().book, ownership: 'unowned' } })
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.book.ownership, 'owned'); assert.equal(duplicate.book.status, 'reading')
    const legacy = s.apply('a', { ...add(), opId: 'legacy-edit', revision: 1, book: { ...add().book, status: 'finished' } }).book
    assert.equal(legacy.ownership, 'owned'); assert.equal(legacy.status, 'finished')
    const unowned = s.apply('a', { ...add('third-book', 'Unowned title'), book: { ...add().book, title: 'Unowned title', ownership: 'unowned', libraryItemId: 'shared-copy' } }).book
    assert.equal(unowned.ownership, 'unowned')
    const unspecified = s.apply('a', { ...add('fourth-book', 'Unknown ownership'), book: { ...add().book, title: 'Unknown ownership', libraryItemId: 'shared-copy' } }).book
    assert.equal(unspecified.ownership, 'unspecified')
    assert.throws(() => s.apply('a', { ...add('bad-book'), book: { ...add().book, ownership: ['owned', 'unowned'] } }), { status: 400 })
    const changed = s.apply('a', { ...add(), opId: 'ownership-change', revision: 2, book: { ...add().book, ownership: 'unowned' } }).book
    assert.equal(changed.ownership, 'unowned'); assert.equal(changed.status, 'to-read')
  } finally { s.close() }
})
