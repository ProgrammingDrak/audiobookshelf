import { bookKey } from './reading-store.mjs'
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : ''
export function postgresOptions(value) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid reading database URL')
  // Never permit URL options to override verified TLS or connection isolation.
  if (url.search) throw new Error('Reading database URL must not contain connection options')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return { connectionString: value, ssl: local ? false : { rejectUnauthorized: true }, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 }
}
const decode = row => row ? { ownership: 'unspecified', ...row.body, id: row.id, revision: row.revision, deleted: row.deleted } : null
export function createPostgresReadingStore(pool) {
  return {
    async list(owner) { return (await pool.query('SELECT * FROM quietshelf.books WHERE owner=$1 ORDER BY created_at DESC,id', [owner])).rows.map(decode) },
    async apply(owner, op) {
      if (!owner || typeof op?.opId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(op.opId) || typeof op.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(op.id)) throw fail('Invalid operation')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Owner-wide lock protects absent rows and normalized-title duplicate adds too.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['quietshelf:' + owner])
        const receipt = (await client.query('SELECT body FROM quietshelf.receipts WHERE owner=$1 AND op=$2', [owner, op.opId])).rows[0]
        if (receipt) { await client.query('COMMIT'); return receipt.body }
        const current = decode((await client.query('SELECT * FROM quietshelf.books WHERE owner=$1 AND id=$2', [owner, op.id])).rows[0])
        if (!['save', 'remove', 'restore'].includes(op.action)) throw fail('Invalid action')
        if (current && op.revision !== current.revision) throw fail('This book changed on another device. Reload its saved version before editing again.', 409)
        if (!current && (op.action !== 'save' || op.revision !== 0)) throw fail('Book not found', 404)
        if (current?.deleted && op.action === 'save') throw fail('This book was removed. Restore it before editing.', 409)
        let next = current ? { ...current } : { id: op.id, revision: 0, deleted: false }
        if (op.action === 'save') {
          next = { ...next, title: text(op.book?.title,300), author: text(op.book?.author,200), notes: text(op.book?.notes,4000), status: op.book?.status, ownership: op.book?.ownership ?? current?.ownership ?? 'unspecified', libraryItemId: text(op.book?.libraryItemId,100) }
          if (!['owned','unowned','unspecified'].includes(next.ownership)) throw fail('Choose Owned, Unowned, or Not specified')
          if (!next.title || !['to-read','reading','finished'].includes(next.status) || (next.libraryItemId && !/^[a-zA-Z0-9_-]+$/.test(next.libraryItemId))) throw fail('A title and valid reading status are required')
        }
        next.deleted = op.action === 'remove'
        const duplicate = (await client.query('SELECT * FROM quietshelf.books WHERE owner=$1 AND book_key=$2 AND NOT deleted AND id<>$3', [owner, bookKey(next.title,next.author), next.id])).rows[0]
        let result
        if (!next.deleted && duplicate) {
          if (current) throw fail('That title and author are already on your shelf.',409)
          result = { book: decode(duplicate), duplicate: true }
        } else {
          next.revision++; next.updatedAt = new Date().toISOString()
          await client.query('INSERT INTO quietshelf.books(owner,id,book_key,body,revision,deleted) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner,id) DO UPDATE SET book_key=excluded.book_key,body=excluded.body,revision=excluded.revision,deleted=excluded.deleted', [owner,next.id,bookKey(next.title,next.author),next,next.revision,next.deleted])
          result = { book: next }
        }
        await client.query('INSERT INTO quietshelf.receipts(owner,op,body) VALUES($1,$2,$3)', [owner,op.opId,result])
        await client.query('COMMIT'); return result
      } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') throw fail('That title and author are already on your shelf.',409); throw error }
      finally { client.release() }
    },
    close: () => pool.end()
  }
}
export async function openPostgresReadingStore(url) {
  const { Pool } = await import('pg')
  const pool = new Pool(postgresOptions(url))
  pool.on('error', () => {}) // Failed requests return a sanitized 503; never log connection strings.
  try {
    await pool.query('SELECT owner,id,book_key,body,revision,deleted,created_at FROM quietshelf.books LIMIT 0')
    await pool.query('SELECT owner,op,body FROM quietshelf.receipts LIMIT 0')
    return createPostgresReadingStore(pool)
  } catch (error) { await pool.end(); throw error }
}
