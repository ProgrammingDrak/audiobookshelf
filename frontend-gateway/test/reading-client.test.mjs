import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../../client/lib/reading-shelf.js', import.meta.url), 'utf8')
const { createShelf } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const op = id => ({ id, opId: 'operation-' + id, action: 'save', revision: 0, book: { title: id, author: '', status: 'to-read' } })
function fixture(request) {
  const map = new Map(); let tail = Promise.resolve()
  const storage = { getItem: k => map.get(k), setItem: (k,v) => map.set(k,v) }
  const lock = fn => { const run = tail.then(fn); tail = run.catch(() => {}); return run }
  const make = (userId = 'one') => createShelf({ userId, storage, lock, request, notify() {} })
  return { storage, make }
}
test('offline outbox survives reload, retries exactly once and keeps acknowledged book after final pull failure', async () => {
  let fail = true, gets = 0, writes = 0
  const f = fixture(async (method, body) => {
    if (method === 'GET') { gets++; if (gets === 3) throw new Error('offline after save'); return { userId: 'one', books: [] } }
    if (fail) throw new Error('offline')
    writes++; return { book: { ...body.book, id: body.id, revision: 1 } }
  })
  const a = f.make(); await a.enqueue(op('book-one')); await a.sync()
  assert.equal(a.view().pending, 1)
  const b = f.make(); assert.equal(b.view().books[0].title, 'book-one')
  fail = false; await b.sync(); assert.equal(writes, 1); assert.equal(b.view().pending, 0); assert.equal(b.view().books[0].revision, 1); assert.match(b.view().error, /offline/)
})
test('account mismatch makes no POST and local write failure does not acknowledge the draft', async () => {
  let posts = 0
  const f = fixture(async method => { if (method === 'POST') posts++; return { userId: 'other', books: [] } })
  const a = f.make(); await a.enqueue(op('book-one')); await a.sync(); assert.equal(posts, 0); assert.equal(a.view().pending, 1)
  f.storage.setItem = () => { throw new Error('quota') }
  await assert.rejects(a.enqueue(op('book-two')), /quota/); assert.equal(a.view().pending, 1)
})
test('two tabs serialize local adds and preserve edits queued during network requests', async () => {
  let release; const wait = new Promise(r => { release = r }); let first = true
  const books = []
  const f = fixture(async (method, body) => {
    if (method === 'GET') { if (first) { first = false; await wait } return { userId: 'one', books: [...books] } }
    const book = { ...body.book, id: body.id, revision: 1 }; books.push(book); return { book }
  })
  const a = f.make(), b = f.make()
  await Promise.all([a.enqueue(op('book-one')), b.enqueue(op('book-two'))])
  a.refresh(); assert.equal(a.view().pending, 2)
  const sync = a.sync(); await b.enqueue(op('book-three')); release(); await sync
  assert.equal(a.view().pending, 0); assert.equal(a.view().books.length, 3)
})
