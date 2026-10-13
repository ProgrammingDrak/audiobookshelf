import { configuration, createGateway } from './server.mjs'
import { createMockBackend } from './test/mock-backend.mjs'
const port = Number(process.env.DEMO_PORT || 13379)
const backendPort = Number(process.env.DEMO_BACKEND_PORT || 13380)
const backend = createMockBackend()
await new Promise(resolve => backend.server.listen(backendPort, '127.0.0.1', resolve))
const gateway = createGateway(configuration({ PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, ABS_UPSTREAM: `http://127.0.0.1:${backendPort}`, EXPECTED_BACKEND_VERSION: '2.37.1', BUILD_REVISION: 'local-synthetic-demo' }))
await new Promise(resolve => gateway.listen(port, '127.0.0.1', resolve))
console.log(`LOCAL SYNTHETIC DEMO http://127.0.0.1:${port}/audiobookshelf/login — username demo, password demo. Memory-only tone/progress; no Jesse access.`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await gateway.shutdown(); await backend.close(); process.exit(0) })
