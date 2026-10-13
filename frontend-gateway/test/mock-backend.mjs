import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../client/package.json', import.meta.url))
const { Server } = require('socket.io')

export const demoItem = {
  id: 'demo-book', libraryId: 'demo-library', folderId: 'demo-folder', path: '/synthetic/demo', relPath: 'demo', isFile: false, isMissing: false, isInvalid: false, mediaType: 'book', size: 960044, addedAt: 1700000000000, updatedAt: 1700000000000, libraryFiles: [],
  media: { id: 'demo-media', coverPath: null, tags: ['Synthetic demo'], audioFiles: [], ebookFile: null, numTracks: 1, numAudioFiles: 1, duration: 60, size: 960044,
    metadata: { title: 'Local Gateway Demo', titleIgnorePrefix: 'Local Gateway Demo', subtitle: 'Synthetic audio • no real library', authorName: 'Demo Author', authorNameLF: 'Author, Demo', narratorName: 'Generated tone', authors: [{ id: 'demo-author', name: 'Demo Author' }], narrators: ['Generated tone'], series: [], genres: [], language: 'English', description: '<p>This is throwaway local data. Play the generated tone, seek, and resume to test the gateway.</p>', explicit: false, abridged: false },
    chapters: [{ id: 0, start: 0, end: 60, title: 'Synthetic audio' }],
    tracks: [{ index: 0, duration: 60, startOffset: 0, title: 'Demo tone', mimeType: 'audio/wav', contentUrl: '/synthetic.wav', metadata: { filename: 'synthetic.wav', ext: '.wav' } }]
  }
}

function audio() {
  const samples = 8000 * 60, wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 8000) * 1200), 44 + i * 2)
  return wav
}

export function createMockBackend(prefix = '') {
  const requests = [], bytes = audio()
  let currentTime = 0, version = '2.37.1', initialized = true, appName = 'audiobookshelf', authMethods = ['local'], accessToken = 'demo-access-1', refreshToken = 'demo-refresh-1', rotations = 0
  const user = () => ({ id: 'demo-user', username: 'demo', type: 'user', isActive: true, accessToken, token: accessToken, permissions: { accessAllLibraries: true, download: false, update: false, delete: false, upload: false, accessExplicitContent: true }, librariesAccessible: [], bookmarks: [], seriesHideFromContinueListening: [], mediaProgress: currentTime ? [{ id: 'demo-progress', libraryItemId: demoItem.id, currentTime, duration: 60, progress: currentTime / 60, isFinished: false }] : [] })
  const library = { id: 'demo-library', name: 'LOCAL SYNTHETIC DEMO', mediaType: 'book', displayOrder: 1, icon: 'audiobooks', provider: 'audible', folders: [], settings: { coverAspectRatio: 1, audiobooksOnly: true } }
  const login = () => ({ user: user(), userDefaultLibraryId: library.id, serverSettings: { language: 'en-us', version, chromecastEnabled: false, sortingIgnorePrefix: true, scannerFindCovers: false, homeBookshelfView: 0, bookshelfView: 0 }, Source: 'local-mock', ereaderDevices: [] })
  const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
  const cookie = () => `refresh_token=${refreshToken}; Path=/; HttpOnly; SameSite=Lax${'; Secure'}`
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString()
    let body = {}; try { body = JSON.parse(bodyText || '{}') || {} } catch {}
    requests.push({ url: req.url, method: req.method, headers: req.headers, body })
    const pathname = new URL(req.url, 'http://mock').pathname
    if (prefix && !pathname.startsWith(prefix + '/')) return json(res, 404, { error: 'wrong_prefix' })
    const local = pathname.slice(prefix.length)
    if (local === '/status') return json(res, 200, { app: appName, serverVersion: version, isInit: initialized, language: 'en-us', authMethods, authFormData: { authLoginCustomMessage: '<b>LOCAL SYNTHETIC DEMO</b> — demo / demo. No real library or account.' } })
    if (local === '/login') {
      if (body.username !== 'demo' || body.password !== 'demo') return json(res, 401, { error: 'invalid_credentials' })
      // Demo runs on HTTP; real tests also cover preservation of Secure cookies.
      return json(res, 200, login(), { 'set-cookie': cookie().replace(/; Secure$/, '') })
    }
    if (local === '/auth/refresh') {
      if (!req.headers.cookie?.includes(`refresh_token=${refreshToken}`)) return json(res, 401, { error: 'invalid_refresh' })
      accessToken = `demo-access-${++rotations + 1}`; refreshToken = `demo-refresh-${rotations + 1}`
      return json(res, 200, login(), { 'set-cookie': [cookie() + '; Domain=mock.invalid', 'other=test; Path=/; HttpOnly; SameSite=Strict'] })
    }
    if (local === '/auth/redirect') { res.writeHead(302, { location: `http://${req.headers.host}${prefix}/login?synthetic=1` }); return res.end() }
    if (local === '/logout') return json(res, 200, {}, { 'set-cookie': 'refresh_token=; Path=/; HttpOnly; Max-Age=0' })
    if (local.startsWith('/public/session/')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      let start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : bytes.length - 1
      end = Math.min(end, bytes.length - 1)
      if (start > end || start >= bytes.length) { res.writeHead(416, { 'content-range': `bytes */${bytes.length}` }); return res.end() }
      res.writeHead(range ? 206 : 200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) })
      return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
    }
    if (local.startsWith('/hls/')) { res.writeHead(200, { 'content-type': local.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' }); return res.end(local.endsWith('.m3u8') ? '#EXTM3U\n#EXTINF:6,\nsegment-1.ts\n' : Buffer.from('synthetic-segment')) }
    if (local === '/api/unauthorized') return json(res, 401, { error: 'expired' })
    if (local.startsWith('/api/') && req.headers.authorization !== `Bearer ${accessToken}`) return json(res, 401, { error: 'expired' })
    if (local === '/api/authorize') return json(res, 200, login())
    if (local === '/api/libraries') return json(res, 200, { libraries: [library] })
    if (local === '/api/libraries/demo-library') return json(res, 200, { library, filterdata: { authors: [], genres: [], tags: [], series: [], narrators: [], publishers: [], languages: ['English'], publishedDecades: [] }, issues: 0, numUserPlaylists: 0 })
    if (local.endsWith('/personalized')) return json(res, 200, [{ id: 'recently-added', type: 'book', label: 'Recently Added', labelStringKey: 'LabelRecentlyAdded', entities: [demoItem] }])
    if (local.endsWith('/items')) return json(res, 200, { results: [demoItem], total: 1, limit: 100, page: 0 })
    if (local === '/api/items/demo-book') return json(res, 200, demoItem)
    if (local === '/api/items/demo-book/play') return json(res, 200, { id: 'demo-session', userId: 'demo-user', libraryItemId: demoItem.id, libraryId: library.id, bookId: demoItem.media.id, mediaType: 'book', mediaMetadata: demoItem.media.metadata, displayTitle: demoItem.media.metadata.title, displayAuthor: 'Demo Author', duration: 60, playMethod: 0, currentTime, startTime: currentTime, audioTracks: demoItem.media.tracks, chapters: demoItem.media.chapters, libraryItem: demoItem })
    if (local === '/api/session/demo-session/sync' || local === '/api/session/demo-session/close' || local === '/api/me/progress/demo-book') {
      currentTime = body.currentTime ?? currentTime
      const data = user().mediaProgress[0]
      io.emit('user_item_progress_updated', { id: 'demo-progress', data, sessionId: 'demo-session', deviceDescription: 'synthetic mock' })
      return json(res, 200, { currentTime })
    }
    if (local === '/api/me') return json(res, 200, user())
    if (local === '/api/search/providers') return json(res, 200, { providers: [], customProviders: [] })
    if (/\/(collections|playlists|sessions)$/.test(local)) return json(res, 200, { collections: [], playlists: [], sessions: [] })
    return json(res, 404, { error: 'mock_route_not_implemented', path: local })
  })
  const io = new Server(server, { path: prefix + '/socket.io' })
  io.on('connection', socket => socket.on('auth', token => {
    if (token !== accessToken) return socket.emit('auth_failed', { message: 'Invalid mock token' })
    socket.emit('init', { usersOnline: [] })
  }))
  return { server, io, requests, bytes, get currentTime() { return currentTime }, set version(value) { version = value }, set initialized(value) { initialized = value }, set appName(value) { appName = value }, set authMethods(value) { authMethods = value }, expireAccess() { accessToken = 'expired-server-side' }, close: () => new Promise(resolve => io.close(resolve)) }
}
