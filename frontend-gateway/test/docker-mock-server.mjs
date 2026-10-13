import { createMockBackend } from './mock-backend.mjs'
const mock = createMockBackend(process.env.MOCK_BASE || '')
if (process.env.ABS_MOCK_VERSION) mock.version = process.env.ABS_MOCK_VERSION
mock.server.listen(13380, '0.0.0.0', () => console.log('Synthetic Docker backend ready'))
process.on('SIGTERM', async () => { await mock.close(); process.exit(0) })
