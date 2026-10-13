import http from 'node:http'
import { readFileSync } from 'node:fs'
const metadata = JSON.parse(readFileSync(new URL('../../release.json', import.meta.url), 'utf8'))
const origin = new URL(process.env.PUBLIC_ORIGIN)
const request = http.get({ host: '127.0.0.1', port: Number(process.env.PORT || 8080), path: '/readyz', headers: { host: origin.host }, timeout: 3500 }, response => {
  let body = ''
  response.on('data', chunk => body += chunk)
  response.on('end', () => {
    try { const status = JSON.parse(body); process.exitCode = response.statusCode === 200 && status.ok && status.revision === metadata.revision ? 0 : 1 } catch { process.exitCode = 1 }
  })
  response.on('error', () => { process.exitCode = 1 })
})
request.on('timeout', () => request.destroy())
request.on('error', () => { process.exitCode = 1 })
