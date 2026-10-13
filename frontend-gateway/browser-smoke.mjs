// Optional local visual verification in an isolated headless Chrome profile.
// Uses no interactive tabs, saved browser profile, or real ABS server.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const profile = await mkdtemp(path.join(os.tmpdir(), 'abs-demo-chrome-'))
const out = path.resolve(process.env.SMOKE_OUTPUT || 'frontend-gateway/out/screenshots')
await mkdir(out, { recursive: true })
const chrome = spawn(process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--disable-background-networking', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let log = ''
const endpoint = await new Promise((resolve, reject) => {
  chrome.stderr.on('data', chunk => { log += chunk; const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log); if (match) resolve(match[1]) })
  chrome.on('error', reject); chrome.on('exit', code => reject(new Error(`Chrome exited ${code}`)))
})
const socket = new WebSocket(endpoint)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let id = 0, sessionId
const pending = new Map(), errors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result) }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''))
})
const call = (method, params = {}, target = sessionId) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params, ...(target ? { sessionId: target } : {}) })) })
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const waitFor = async (expression, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${expression}; page=${await evaluate('document.body.innerText')}; exceptions=${errors.join('; ')}`)
}
const screenshot = async name => { const result = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(out, name), Buffer.from(result.data, 'base64')) }
try {
  const target = await call('Target.createTarget', { url: 'about:blank' }, null)
  sessionId = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
  await call('Runtime.enable'); await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: 'http://127.0.0.1:13379/audiobookshelf/login' })
  await waitFor('document.body.innerText.includes("LOCAL SYNTHETIC DEMO")')
  await screenshot('login.png')
  await evaluate(`(() => { for (const [selector,value] of [['input[name="username"]','demo'],['input[autocomplete="current-password"]','demo']]) { const input=document.querySelector(selector); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('button[type="submit"]').click(); })()`)
  await waitFor('location.pathname.includes("/library/demo-library") && document.body.innerText.includes("Local Gateway Demo")')
  await screenshot('bookshelf.png')
  await evaluate(`document.querySelector('[cy-id="playButton"] > div').click()`)
  await waitFor('!!document.querySelector("audio") && document.querySelector("audio").readyState >= 2 && !document.querySelector("audio").paused')
  await evaluate('document.querySelector("audio").currentTime = 23')
  await waitFor('document.querySelector("audio").currentTime >= 24 && document.body.innerText.includes("0:24")')
  await screenshot('player.png')
  await waitFor('window.$nuxt.$store.state.user.user.mediaProgress.some(p => p.currentTime >= 23)', 450)
  const progress = await evaluate('window.$nuxt.$store.state.user.user.mediaProgress[0].currentTime')
  const evidence = { url: await evaluate('location.href'), audio: await evaluate('({readyState:document.querySelector("audio").readyState,paused:document.querySelector("audio").paused,currentTime:document.querySelector("audio").currentTime,duration:document.querySelector("audio").duration})'), backendProgress: progress, exceptions: errors, result: 'login/bookshelf/audio/seek/progress passed with synthetic backend' }
  assert.equal(errors.length, 0)
  await writeFile(path.join(out, 'browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  socket.close(); chrome.kill('SIGTERM'); await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve) }); await rm(profile, { recursive: true, force: true })
}
