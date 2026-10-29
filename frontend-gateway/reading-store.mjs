import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : ''
export const bookKey = (title, author) => createHash('sha256').update([title, author].map(s => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()).join('\0')).digest('hex')
export function openReadingStore(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS books(owner TEXT NOT NULL,id TEXT NOT NULL,book_key TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id));
    CREATE UNIQUE INDEX IF NOT EXISTS unique_live_book ON books(owner,book_key) WHERE deleted=0;
    CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL,op TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,op));`)
  const decode = row => row ? { ...JSON.parse(row.body), id: row.id, revision: row.revision, deleted: !!row.deleted } : null
  const get = (owner, id) => decode(db.prepare('SELECT * FROM books WHERE owner=? AND id=?').get(owner, id))
  const list = owner => db.prepare('SELECT * FROM books WHERE owner=? ORDER BY rowid DESC').all(owner).map(decode)
  function apply(owner, op) {
    if (!owner || typeof op?.opId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(op.opId) || typeof op.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(op.id)) throw fail('Invalid operation')
    db.exec('BEGIN IMMEDIATE')
    try {
      const receipt = db.prepare('SELECT body FROM receipts WHERE owner=? AND op=?').get(owner, op.opId)
      if (receipt) { db.exec('COMMIT'); return JSON.parse(receipt.body) }
      const current = get(owner, op.id)
      if (!['save', 'remove', 'restore'].includes(op.action)) throw fail('Invalid action')
      if (current && op.revision !== current.revision) throw fail('This book changed on another device. Reload its saved version before editing again.', 409)
      if (!current && (op.action !== 'save' || op.revision !== 0)) throw fail('Book not found', 404)
      if (current?.deleted && op.action === 'save') throw fail('This book was removed. Restore it before editing.', 409)
      let next = current ? { ...current } : { id: op.id, revision: 0, deleted: false }
      if (op.action === 'save') {
        next = { ...next, title: text(op.book?.title, 300), author: text(op.book?.author, 200), notes: text(op.book?.notes, 4000), status: op.book?.status, libraryItemId: text(op.book?.libraryItemId, 100) }
        if (!next.title || !['to-read', 'reading', 'finished'].includes(next.status) || (next.libraryItemId && !/^[a-zA-Z0-9_-]+$/.test(next.libraryItemId))) throw fail('A title and valid reading status are required')
      }
      next.deleted = op.action === 'remove'
      const duplicate = db.prepare('SELECT * FROM books WHERE owner=? AND book_key=? AND deleted=0 AND id<>?').get(owner, bookKey(next.title, next.author), next.id)
      let result
      if (!next.deleted && duplicate) {
        if (current) throw fail('That title and author are already on your shelf.', 409)
        result = { book: decode(duplicate), duplicate: true }
      } else {
        next.revision++
        next.updatedAt = new Date().toISOString()
        db.prepare('INSERT INTO books VALUES(?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET book_key=excluded.book_key,body=excluded.body,revision=excluded.revision,deleted=excluded.deleted').run(owner, next.id, bookKey(next.title, next.author), JSON.stringify(next), next.revision, Number(next.deleted))
        result = { book: next }
      }
      db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(owner, op.opId, JSON.stringify(result))
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { list, apply, close: () => db.close() }
}

export function readingHandler(config) {
  let store
  return async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }); res.end(JSON.stringify(body)) }
    try {
      if (!config.readingDb) return reply(503, { error: 'The host has not configured persistent reading-list storage yet.' })
      if (!req.headers.authorization?.startsWith('Bearer ')) return reply(401, { error: 'Sign in to QuietShelf.' })
      const response = await fetch(config.upstream.origin + config.upstream.pathname.replace(/\/$/, '') + '/api/me', { headers: { authorization: req.headers.authorization }, redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (!response.ok) return reply(response.status === 401 || response.status === 403 ? 401 : 502, { error: 'Could not verify your library account.' })
      const user = await response.json()
      if (typeof user.id !== 'string' || !user.id || user.isActive === false) return reply(401, { error: 'Sign in to QuietShelf.' })
      // Never accept a user or backend identity from the request body.
      const owner = createHash('sha256').update(config.upstream.href + '\0' + user.id).digest('hex')
      store ||= openReadingStore(config.readingDb)
      if (req.method === 'GET') return reply(200, { books: store.list(owner), userId: user.id })
      if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' })
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON required' })
      let data = ''
      for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 16000) return reply(413, { error: 'Book details are too large' }) }
      const op = JSON.parse(data)
      // An identity assertion prevents an old tab's outbox reaching a new login.
      if (op.userId !== user.id) return reply(409, { error: 'Account changed. Your pending edits remain on this device.' })
      return reply(200, store.apply(owner, op))
    } catch (error) { return reply(error.status || (error instanceof SyntaxError ? 400 : 503), { error: error.status ? error.message : 'Reading list unavailable; your pending edits are kept.' }) }
  }
}
