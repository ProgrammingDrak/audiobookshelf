import { DatabaseSync } from 'node:sqlite'
import { bookKey } from './reading-store.mjs'
// Explicit offline import only; never called during app startup.
export async function importReadingSqlite(pool, filename, { sourceUpstream, targetUpstream, writesStopped } = {}) {
  if (writesStopped !== true || !sourceUpstream || sourceUpstream !== targetUpstream) throw new Error('Stop writes and verify the unchanged backend namespace before migration')
  const db = new DatabaseSync(filename, { readOnly: true })
  let books, receipts
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Source database integrity check failed')
    db.exec('BEGIN')
    books = db.prepare('SELECT * FROM books ORDER BY rowid').all(); receipts = db.prepare('SELECT * FROM receipts').all()
    db.exec('COMMIT')
  } finally { db.close() }
  for (const b of books) {
    const body = JSON.parse(b.body)
    if (!b.owner || !b.id || b.book_key !== bookKey(body.title,body.author) || b.revision < 1 || ![0,1].includes(b.deleted)) throw new Error('Source row validation failed')
  }
  for (const r of receipts) { if (!r.owner || !r.op || !JSON.parse(r.body)?.book) throw new Error('Source receipt validation failed') }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE quietshelf.books,quietshelf.receipts IN ACCESS EXCLUSIVE MODE')
    const counts = await client.query('SELECT (SELECT count(*) FROM quietshelf.books)::int AS books,(SELECT count(*) FROM quietshelf.receipts)::int AS receipts')
    if (counts.rows[0].books || counts.rows[0].receipts) throw new Error('Migration target must be empty; refusing overwrite or replay')
    for (const b of books) await client.query('INSERT INTO quietshelf.books(owner,id,book_key,body,revision,deleted) VALUES($1,$2,$3,$4,$5,$6)',[b.owner,b.id,b.book_key,JSON.parse(b.body),b.revision,!!b.deleted])
    for (const r of receipts) await client.query('INSERT INTO quietshelf.receipts(owner,op,body) VALUES($1,$2,$3)',[r.owner,r.op,JSON.parse(r.body)])
    const after = (await client.query('SELECT (SELECT count(*) FROM quietshelf.books)::int AS books,(SELECT count(*) FROM quietshelf.receipts)::int AS receipts')).rows[0]
    if (after.books !== books.length || after.receipts !== receipts.length) throw new Error('Migration verification failed')
    await client.query('COMMIT'); return after
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
