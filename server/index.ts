// Bottle Imp server — Express + Socket.IO bootstrap.
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { registerHandlers } from './handlers'
import { connectedPlayerCount, restorePersistedRooms, roomCount, setIo, startCleanupTimer } from './rooms'
import pkg from '../package.json' assert { type: 'json' }

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3001)

const app = express()
const httpServer = createServer(app)

// Allowed browser origins. Prod serves the client from the same origin
// (Pangolin HTTPS edge), so same-origin requests never carry an Origin header
// that matters; this list only gates cross-origin browser calls. Dev uses
// Vite on another port. Configure with CORS_ORIGINS (comma-separated) if you
// serve the client from a different origin later.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: false,
  },
})

setIo(io)

// Serve the built client if present (production/Docker).
const clientDist = join(__dirname, '..', 'client', 'dist')
app.use(express.static(clientDist))

// Health check for hosts, load balancers, and uptime monitors.
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    version: (pkg as { version?: string }).version ?? '0.0.0',
    mode: process.env.NODE_ENV || 'development',
    node: process.version,
    uptime: process.uptime(),
    rooms: roomCount(),
    players: connectedPlayerCount(),
  })
})

registerHandlers(io)

restorePersistedRooms()
startCleanupTimer()

httpServer.listen(PORT, () => {
  console.log(`[bottleimp] listening on :${PORT}`)
})
