<template>
  <main class="reading-page">
    <header><p class="eyebrow">YOUR QUIETSHELF</p><h1>Make room for a good book.</h1><p>Keep what you want to read, what you’re reading, and what you’ve finished. Owning a copy is optional.</p>
      <button class="save-state" :aria-expanded="showSync" @click="showSync = !showSync">{{ state.saved ? 'Saved locally' : 'Loading shelf' }} · {{ state.syncing ? 'Syncing…' : state.error ? 'Needs attention' : state.pending ? 'Waiting to sync' : state.saved ? 'Synced' : 'Connecting' }}</button>
      <div v-if="showSync" class="sync-details"><p>{{ state.error || 'Your reading list is private to this library account.' }}</p><p>{{ state.pending }} pending edits. {{ state.conflicts }} retained conflict drafts.</p><button @click="sync">Sync now</button><button v-if="state.conflicts" @click="exportConflicts">Download conflict drafts</button></div>
    </header>
    <p v-if="message" role="status">{{ message }}</p>
    <form class="book-form" @submit.prevent="save">
      <h2>{{ editing ? 'Edit book' : 'Add a book' }}</h2>
      <div class="form-grid"><label>Title<input v-model="draft.title" required maxlength="300" /></label><label>Author<input v-model="draft.author" maxlength="200" placeholder="Optional" /></label></div>
      <div class="form-grid"><label>Shelf<select v-model="draft.status"><option value="to-read">To read</option><option value="reading">Reading</option><option value="finished">Finished</option></select></label><label>Library book link (optional)<input v-model="draft.libraryLink" maxlength="1000" placeholder="Paste a book link from this QuietShelf library" /></label></div>
      <label>Notes<textarea v-model="draft.notes" maxlength="4000" rows="2" placeholder="What made you want to read it?" /></label>
      <div class="actions"><button class="primary" type="submit">{{ editing ? 'Save changes' : 'Add to shelf' }}</button><button v-if="editing" type="button" @click="reset">Cancel edit</button></div>
    </form>
    <nav class="shelf-filters" aria-label="Reading shelves"><button v-for="s in shelves" :key="s.id" :aria-pressed="selected.includes(s.id)" @click="toggle(s.id)">{{ s.label }} <span>{{ count(s.id) }}</span></button><button @click="selected = shelves.map(s => s.id)">Show all</button><button @click="selected = []">Clear</button></nav>
    <div class="books"><article v-for="book in visible" :id="'book-' + book.id" :key="book.id" :class="{ focused: $route.query.book === book.id }">
      <div class="book-spine" aria-hidden="true">{{ book.title.charAt(0) }}</div><div class="book-body"><p class="eyebrow">{{ label(book) }}</p><h2>{{ book.title }}</h2><p>{{ book.author || 'Author not added' }}</p><p v-if="book.notes" class="notes">{{ book.notes }}</p><p class="availability">{{ book.libraryItemId ? 'Linked to your library' : 'No library copy linked' }}{{ book.pending ? ' · Waiting to sync' : '' }}</p>
      <div class="actions"><template v-if="!book.deleted"><button :disabled="book.pending" @click="edit(book)">Edit</button><nuxt-link v-if="book.libraryItemId" :to="'/item/' + book.libraryItemId">Open library copy</nuxt-link><button :disabled="book.pending" @click="plan(book)">Plan reading time</button><button :disabled="book.pending" @click="remove(book)">Remove</button></template><button v-else :disabled="book.pending" @click="mutate(book, 'restore')">Restore book</button><button v-if="book.pending && state.error" @click="resolve(book)">Use saved version</button></div></div>
    </article></div>
    <p v-if="!visible.length" class="empty">{{ selected.length ? 'No books on these shelves yet. Add any title above, even before you own it.' : 'Choose a shelf to see your books.' }}</p>
    <button class="removed-toggle" @click="showRemoved = !showRemoved">{{ showRemoved ? 'Hide' : 'Show' }} removed books</button>
    <section v-if="planning" class="book-form"><h2>Make time for {{ planning.title }}</h2><label>Minutes<input v-model.number="minutes" type="number" min="1" max="240" /></label><p>DCC will open a draft. Save it there when you want a reading session.</p><div class="actions"><a class="primary" :href="dccLink" rel="noreferrer">Continue to DCC</a><button @click="planning = null">Cancel</button></div></section>
  </main>
</template>
<script>
import { createShelf } from '~/lib/reading-shelf'
const blank = () => ({ title: '', author: '', notes: '', status: 'to-read', libraryItemId: '', libraryLink: '' })
export default {
  data: () => ({ shelf: null, state: { books: [], pending: 0, error: '', saved: false }, draft: blank(), editing: null, selected: ['to-read', 'reading', 'finished'], shelves: [{ id: 'to-read', label: 'To read' }, { id: 'reading', label: 'Reading' }, { id: 'finished', label: 'Finished' }], showRemoved: false, showSync: false, message: '', planning: null, minutes: 30, sessionId: '', timer: null }),
  computed: {
    userId() { return this.$store.state.user.user?.id },
    visible() { return this.state.books.filter(b => b.deleted ? this.showRemoved : this.selected.includes(b.status)) },
    dccLink() {
      if (!this.planning || !Number.isInteger(this.minutes) || this.minutes < 1 || this.minutes > 240) return null
      const back = new URL(this.$config.routerBasePath + '/reading', window.location.origin)
      back.searchParams.set('book', this.planning.id)
      const payload = { title: this.planning.title, author: this.planning.author, url: back.href, minutes: this.minutes, requestId: this.sessionId }
      return 'https://daily-command-center-production-1d04.up.railway.app/#reading=' + encodeURIComponent(JSON.stringify(payload))
    }
  },
  watch: { userId() { this.state = { books: [], pending: 0, saved: false }; this.shelf = null; this.reset(); this.planning = null; this.init() } },
  mounted() { this.init(); window.addEventListener('online', this.sync); window.addEventListener('storage', this.storageChanged); document.addEventListener('visibilitychange', this.visibleChanged); this.timer = setInterval(this.sync, 300000) },
  beforeDestroy() { clearInterval(this.timer); window.removeEventListener('online', this.sync); window.removeEventListener('storage', this.storageChanged); document.removeEventListener('visibilitychange', this.visibleChanged) },
  methods: {
    init() {
      const id = this.userId
      if (!id) { this.$router.replace('/login?redirect=' + encodeURIComponent(this.$route.fullPath)); return }
      try {
        this.shelf = createShelf({ userId: id, storage: localStorage, lock: fn => navigator.locks ? navigator.locks.request('quietshelf-reading-write-' + id, fn) : Promise.reject(new Error('This browser does not support safe shelf storage. Use a current browser.')), request: (method, body) => { if (this.userId !== id) throw new Error('Account changed'); return method === 'GET' ? this.$axios.$get('/api/quietshelf/reading', { timeout: 10000 }) : this.$axios.$post('/api/quietshelf/reading', body, { timeout: 10000 }) }, notify: state => { if (this.userId === id) this.state = state } })
        this.state = this.shelf.view(); this.sync()
      } catch { this.message = 'Cannot read local shelf storage. Existing data has not been changed.' }
    },
    sync() { if (!this.shelf) return; const run = () => this.shelf?.sync(); return navigator.locks ? navigator.locks.request('quietshelf-reading-' + this.userId, run) : run() },
    storageChanged() { this.shelf?.refresh() }, visibleChanged() { if (!document.hidden) this.sync() },
    count(status) { return this.state.books.filter(b => !b.deleted && b.status === status).length },
    toggle(id) { this.selected = this.selected.includes(id) ? this.selected.filter(x => x !== id) : [...this.selected, id] },
    label(book) { return book.deleted ? 'Removed' : this.shelves.find(s => s.id === book.status)?.label },
    reset() { this.draft = blank(); this.editing = null },
    edit(book) { this.editing = book; this.draft = { ...book, libraryLink: book.libraryItemId ? new URL(this.$config.routerBasePath + '/item/' + book.libraryItemId, location.origin).href : '' }; this.$el.querySelector('input').focus() },
    async save() {
      try {
        this.draft.libraryItemId = ''
        if (this.draft.libraryLink) { const url = new URL(this.draft.libraryLink); const prefix = this.$config.routerBasePath + '/item/'; const id = url.pathname.slice(prefix.length).replace(/\/$/, ''); if (url.origin !== location.origin || !url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9_-]+$/.test(id) || url.username || url.password || url.search || url.hash) throw new Error('Paste a book link from this QuietShelf library, without query parameters.'); this.draft.libraryItemId = id }
      } catch (e) { this.message = e.message; return }
      const book = this.editing || { id: crypto.randomUUID(), revision: 0 }; if (await this.mutate(book, 'save', this.draft)) this.reset() },
    async mutate(book, action, fields) { try { await this.shelf.enqueue({ opId: crypto.randomUUID(), id: book.id, revision: book.revision, action, ...(fields ? { book: { title: fields.title, author: fields.author, notes: fields.notes, status: fields.status, libraryItemId: fields.libraryItemId } } : {}) }); this.message = 'Saved on this device.'; this.sync(); return true } catch (e) { this.message = e.message; return false } },
    remove(book) { if (confirm('Remove “' + book.title + '” from your reading shelf? You can restore it from Removed books. Its library copy and playback progress stay intact.')) this.mutate(book, 'remove') },
    exportConflicts() { const url = URL.createObjectURL(new Blob([JSON.stringify(this.shelf.conflictDrafts(), null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'quietshelf-conflict-drafts.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) },
    async resolve(book) { if (confirm('Use the server’s saved version? Your pending edit will be retained as a local conflict draft.')) await this.shelf.keepServerVersion(book.id); this.sync() },
    plan(book) { this.planning = book; this.sessionId = crypto.randomUUID(); this.$nextTick(() => this.$el.lastElementChild.scrollIntoView({ block: 'nearest' })) }
  }
}
</script>
<style scoped>
.reading-page{max-width:1000px;margin:auto;padding:28px 24px 120px;color:#eee;overflow-y:auto;height:100%}.reading-page h1{font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.15;margin:8px 0 16px}.reading-page h2{font-size:1.25rem;font-weight:600}.reading-page p{line-height:1.6}.eyebrow{font-size:.72rem;letter-spacing:.15em;text-transform:uppercase;color:#d8bc80}.save-state,.shelf-filters button,.actions button,.actions a,.removed-toggle,.sync-details button{border:1px solid #706656;border-radius:8px;padding:10px 14px;min-height:44px;display:inline-block}.save-state{margin:18px 0}.sync-details,.book-form{padding:20px;background:#242722;border:1px solid #4d5146;border-radius:14px;margin:18px 0}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.reading-page label{display:flex;flex-direction:column;gap:6px;margin:12px 0;font-size:.85rem}.reading-page input,.reading-page select,.reading-page textarea{background:#171b17;border:1px solid #73796a;border-radius:7px;padding:10px;color:#fff;width:100%}.actions,.shelf-filters{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.primary,.shelf-filters button[aria-pressed=true]{background:#d8bc80!important;color:#171b17!important}.books{display:grid;gap:16px;margin:24px 0}.books article{display:flex;border:1px solid #494e43;border-radius:12px;overflow:hidden;background:#20251f;scroll-margin:30px}.books article.focused{outline:2px solid #d8bc80}.book-spine{width:64px;flex-shrink:0;background:#394438;color:#d8bc80;display:flex;justify-content:center;padding:25px 0;font:32px Georgia,serif}.book-body{padding:20px;min-width:0;overflow-wrap:anywhere}.availability{font-size:.8rem;color:#b2baac;margin-top:8px}.notes{white-space:pre-wrap;color:#c8cec1}.empty{padding:30px 0}.reading-page button:disabled{opacity:.45}.reading-page button:focus-visible,.reading-page a:focus-visible{outline:3px solid #ead79c;outline-offset:3px}@media(max-width:600px){.reading-page{padding:18px 12px 120px}.form-grid{grid-template-columns:1fr;gap:0}.book-spine{width:36px;font-size:24px}.book-body{padding:14px}.actions{gap:8px}.book-form{padding:14px}}
</style>
