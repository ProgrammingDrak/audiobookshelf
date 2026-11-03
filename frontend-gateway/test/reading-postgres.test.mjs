import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile,mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { postgresOptions,createPostgresReadingStore } from '../reading-postgres.mjs'
import { openReadingStore } from '../reading-store.mjs'
import { importReadingSqlite } from '../reading-migrate.mjs'
import { configuration } from '../server.mjs'
const op = (id='book-one',title='Café') => ({ id,opId:'operation-'+id,revision:0,action:'save',book:{title,author:'陳',notes:'📚',status:'reading',ownership:'unowned'} })
test('database options enforce verified TLS and explicit storage selection',()=>{
  assert.equal(postgresOptions('postgres://test@127.0.0.1/test').ssl,false)
  assert.equal(postgresOptions('postgres://test@example.invalid/test').ssl.rejectUnauthorized,true)
  assert.throws(()=>postgresOptions('postgres://test@example.invalid/test?sslmode=disable'))
  assert.throws(()=>configuration({READING_DB:':memory:',READING_DATABASE_URL:'postgres://invalid'}))
})
test('real PostgreSQL parity, concurrency, isolation and safeguarded offline import', { skip: !process.env.READING_TEST_DATABASE_URL },async()=>{
  const { Pool } = await import('pg')
  const options=postgresOptions(process.env.READING_TEST_DATABASE_URL)
  assert.equal(options.ssl,false,'tests require disposable localhost database')
  const pool = new Pool(options)
  const dir = await mkdtemp(path.join(tmpdir(),'reading-pg-'))
  try {
    await pool.query(await readFile(new URL('../migrations/001-reading-postgres.sql',import.meta.url),'utf8'))
    const s=createPostgresReadingStore(pool)
    const results=await Promise.all(Array.from({length:8},()=>s.apply('alice',op())))
    assert(results.every(r=>r.book.id==='book-one'));assert.equal((await s.list('alice')).length,1)
    const dup=await s.apply('alice',op('book-two',' CAFÉ '));assert.equal(dup.duplicate,true);assert.equal(dup.book.ownership,'unowned')
    assert.equal((await s.list('bob')).length,0);await s.apply('bob',op())
    await assert.rejects(s.apply('alice',{...op(),opId:'stale-op-123'}),{status:409})
    const removed=await s.apply('alice',{id:'book-one',opId:'remove-123',revision:1,action:'remove'});assert.equal(removed.book.deleted,true)
    await s.apply('alice',op('replacement-book'))
    await assert.rejects(s.apply('alice',{id:'book-one',opId:'restore-collision',revision:2,action:'restore'}),{status:409})
    assert.equal((await s.list('alice')).find(b=>b.id==='book-one').deleted,true)
    await pool.query('TRUNCATE quietshelf.books,quietshelf.receipts')
    const file=path.join(dir,'source.sqlite'), sqlite=openReadingStore(file)
    const first=sqlite.apply('namespace-alice',op());sqlite.apply('namespace-alice',{id:'book-one',opId:'remove-123',revision:1,action:'remove'});sqlite.close()
    await assert.rejects(importReadingSqlite(pool,file,{sourceUpstream:'old',targetUpstream:'new',writesStopped:true}))
    const params={sourceUpstream:'http://same.invalid/',targetUpstream:'http://same.invalid/',writesStopped:true}
    assert.deepEqual(await importReadingSqlite(pool,file,params),{books:1,receipts:2})
    assert.equal((await s.list('namespace-alice'))[0].deleted,true)
    assert.deepEqual(await s.apply('namespace-alice',op()),first,'receipt survives migration')
    await assert.rejects(importReadingSqlite(pool,file,params),/empty/)
    const restored=await s.apply('namespace-alice',{id:'book-one',opId:'restore-success',revision:2,action:'restore'});assert.equal(restored.book.deleted,false);assert.equal(restored.book.title,'Café')
    await pool.query('DO $$ BEGIN CREATE ROLE reading_denied; EXCEPTION WHEN duplicate_object THEN NULL; END $$')
    const restricted=await pool.connect()
    try { await restricted.query('SET ROLE reading_denied'); await assert.rejects(restricted.query('SELECT * FROM quietshelf.books'),e=>e.code==='42501') } finally { await restricted.query('RESET ROLE'); restricted.release() }
    console.log('Real PostgreSQL contract and migration checks passed')
  }finally {await pool.end();await rm(dir,{recursive:true,force:true})}
})
