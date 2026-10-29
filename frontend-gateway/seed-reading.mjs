// Explicit account seed. Existing credentials stay in the environment.
import { createHash } from 'node:crypto'
const origin = new URL(process.argv[2] || 'http://127.0.0.1')
const expectedUser = process.argv[3]
if (!expectedUser || !process.env.QUIETSHELF_ACCESS_TOKEN || !['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Supply gateway origin, verified ABS user ID, and QUIETSHELF_ACCESS_TOKEN in the environment')
const endpoint = origin.origin + '/audiobookshelf/api/quietshelf/reading'
const headers = { authorization: 'Bearer ' + process.env.QUIETSHELF_ACCESS_TOKEN, 'content-type': 'application/json' }
const read = async () => { const r = await fetch(endpoint, { headers, redirect: 'error' }); if (!r.ok) throw new Error('Shelf read failed'); const data = await r.json(); if (data.userId !== expectedUser) throw new Error('Account verification failed'); return data.books }
await read()
for (const [title, author] of [['Between Two Fires', 'Christopher Buehlman'], ['Tender Is the Flesh', 'Agustina Bazterrica']]) {
  const id = 'seed-' + createHash('sha256').update(title + '\0' + author).digest('hex')
  const r = await fetch(endpoint, { method: 'POST', headers, redirect: 'error', body: JSON.stringify({ userId: expectedUser, id, opId: id, action: 'save', revision: 0, book: { title, author, status: 'to-read' } }) })
  if (!r.ok) throw new Error('Seed not accepted; inspect the shelf before retrying')
}
const books = (await read()).filter(b => !b.deleted)
for (const title of ['Between Two Fires', 'Tender Is the Flesh']) if (books.filter(b => b.title === title).length !== 1) throw new Error('Seed verification needs review')
console.log('Verified both requested titles in the selected account. Existing entries preserved.')
