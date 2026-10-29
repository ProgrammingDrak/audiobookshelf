export function createShelf({ userId, storage, request, notify, lock = async fn => fn() }) {
  const key = 'quietshelf:reading:v1:' + userId
  let data = { books: [], pending: [], conflicts: [] }, busy = null, error = '', saved = false
  const load = () => { const raw = storage.getItem(key); if (raw) { data = JSON.parse(raw); saved = true } }
  load()
  const persist = () => { storage.setItem(key, JSON.stringify(data)); saved = true }
  const view = () => {
    const books = new Map(data.books.map(book => [book.id, book]))
    for (const op of data.pending) {
      const old = books.get(op.id) || { id: op.id, revision: 0 }
      books.set(op.id, { ...old, ...op.book, deleted: op.action === 'remove', pending: true })
    }
    return { books: [...books.values()], pending: data.pending.length, error, saved, syncing: !!busy, conflicts: data.conflicts.length }
  }
  const emit = () => notify(view())
  const change = fn => lock(async () => {
    load(); const before = JSON.stringify(data)
    try { fn(); persist() } catch (e) { data = JSON.parse(before); throw e }
    emit()
  })
  async function sync() {
    if (busy) return busy
    busy = (async () => {
      try {
        const remote = await request('GET')
        if (remote.userId !== userId) throw new Error('Account changed. Sign in to the original account to sync these edits.')
        await change(() => { data.books = remote.books })
        error = ''
        while (data.pending.length) {
          const op = data.pending[0]
          const result = await request('POST', { ...op, userId })
          await change(() => {
            // Persist the acknowledged version before removing its outbox entry.
            // A failed follow-up GET must not erase a successful write locally.
            data.books = data.books.filter(b => b.id !== op.id && b.id !== result.book.id)
            data.books.push(result.book)
            data.pending = data.pending.filter(p => p.opId !== op.opId)
          })
        }
        const final = await request('GET')
        if (final.userId !== userId) throw new Error('Account changed')
        await change(() => { data.books = final.books })
      } catch (e) { error = e.response?.data?.error || e.message || 'Waiting to sync' }
    })().finally(() => { busy = null; emit() })
    emit(); return busy
  }
  async function enqueue(op) {
    await change(() => {
      if (data.pending.some(p => p.id === op.id)) throw new Error('This book has an edit waiting to sync. Sync it before editing again.')
      data.pending.push(op)
    })
  }
  async function keepServerVersion(id) {
    await change(() => { data.conflicts.push(...data.pending.filter(p => p.id === id)); data.pending = data.pending.filter(p => p.id !== id) })
  }
  return { view, sync, enqueue, keepServerVersion, conflictDrafts: () => JSON.parse(JSON.stringify(data.conflicts)), refresh: () => { load(); emit() } }
}
