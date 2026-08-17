// Socket.IO connection + event wiring.
import { io, type Socket } from 'socket.io-client'
import { useStore } from './store'
import type { RoomState } from './types'

const SESSION_KEY = 'bottleimp:session' // { code, reconnectToken }
const NAME_KEY = 'bottleimp:name'

let socket: Socket | null = null

function saveSession(code: string, reconnectToken: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ code, reconnectToken }))
}

function loadSession(): { code: string; reconnectToken: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && parsed.code && parsed.reconnectToken) return parsed
  } catch {
    // corrupt — ignore
  }
  return null
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

// When we reconnect, the server replies with room:state. If the token is
// stale (room expired/closed), the server fails silently — clear the session
// after a short window so we don't retry a dead room forever.
function armStaleSessionTimer(): void {
  setTimeout(() => {
    const { room } = useStore.getState()
    if (!room) clearSession()
  }, 3000)
}

export function connect(): Socket {
  if (socket) return socket
  socket = io()
  socket.on('connect', () => {
    useStore.getState().setConnected(true)
    const session = loadSession()
    if (session) {
      armStaleSessionTimer()
      socket!.emit('room:reconnect', { reconnectToken: session.reconnectToken })
    }
  })
  socket.on('disconnect', () => useStore.getState().setConnected(false))

  socket.on('room:state', (room: RoomState) => {
    if (room.code && room.reconnectToken) {
      saveSession(room.code, room.reconnectToken)
      const selfName = room.players?.find((p) => p.id === room.yourId)?.name
      if (selfName) localStorage.setItem(NAME_KEY, selfName)
    }
    useStore.getState().setRoom(room)
  })
  socket.on('game:board', ({ game }) => {
    useStore.getState().setGame(game)
  })
  socket.on('game:scored', ({ game, results, totals }) => {
    useStore.getState().setGame(game)
    useStore.getState().setScored(results, totals)
    useStore.getState().setGameOver(game.phase === 'game_over')
  })
  socket.on('error', ({ message }) => {
    useStore.getState().setError(message)
  })
  socket.on('room:left', () => {
    clearSession()
    useStore.getState().reset()
  })
  socket.on('room:closed', () => {
    clearSession()
    useStore.getState().reset()
    useStore.getState().setError('Room closed by host')
  })
  return socket
}

export function getSocket(): Socket | null {
  return socket
}