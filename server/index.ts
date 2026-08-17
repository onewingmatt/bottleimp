// Bottle Imp server — Express + Socket.IO bootstrap.
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { registerHandlers } from './handlers'
import { restorePersistedRooms, setIo, startCleanupTimer } from './rooms'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3001)

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*', // dev: Vite on another port; prod: same origin
  },
})

setIo(io)

// Serve the built client if present (production/Docker).
const clientDist = join(__dirname, '..', 'client', 'dist')
app.use(express.static(clientDist))

registerHandlers(io)

restorePersistedRooms()
startCleanupTimer()

httpServer.listen(PORT, () => {
  console.log(`[bottleimp] listening on :${PORT}`)
})
