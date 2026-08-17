// Room manager — in-memory Map with periodic cleanup and SQLite write-through.
import { randomUUID } from 'crypto'
import { deleteRoom, loadRooms, saveRoom } from './db'
import { BOT_DELAY_MS } from './botScheduler'
import type { Difficulty, GameState } from '../shared/types'

export interface RoomPlayer {
  id: string
  name: string
  socketId: string | null
  reconnectToken: string
  isBot: boolean
  difficulty: Difficulty
  disconnected: boolean
}

export interface Room {
  code: string
  hostId: string
  players: RoomPlayer[]
  game: GameState | null
  createdAt: number
  updatedAt: number
  // When true, the bot scheduler holds until a human sends game:continue
  // (the hand-over summary overlay is up).
  pausedForSummary?: boolean
  // Per-room bot action delay in ms. Optional; defaults to BOT_DELAY_MS.
  botDelayMs?: number
  // Running total score per player across hands (reset on game:start).
  scores: Record<string, number>
  // Match structure: play hands until someone crosses matchTarget (mode
  // 'target') or until matchHands hands are played (mode 'hands'). Reset on
  // a new match (game:restart after game_over).
  matchMode: 'target' | 'hands'
  matchTarget: number
  matchHands: number
  handsPlayed: number
  matchWinnerId: string | null
  // Hard freeze: the only real player disconnected mid-game. No bot takeover,
  // no bot actions — the game holds exactly here until they reconnect.
  pausedForReconnect?: boolean
}

const rooms = new Map<string, Room>()
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 24 * 60 * 60 * 1000)
const MAX_ROOMS = 10_000

export function generateCode(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = ''
    for (let i = 0; i < 5; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    }
    if (!rooms.has(code)) return code
  }
  throw new Error('Could not generate a unique room code')
}

export function newRoomPlayer(name: string, isBot: boolean, difficulty: Difficulty): RoomPlayer {
  return {
    id: `p${Math.random().toString(36).slice(2, 8)}`,
    name,
    socketId: null,
    reconnectToken: randomUUID(),
    isBot,
    difficulty,
    disconnected: false,
  }
}

export function createRoom(hostName: string): { room: Room; host: RoomPlayer } {
  const code = generateCode()
  const host = newRoomPlayer(hostName, false, 'medium')
  const room: Room = {
    code,
    hostId: host.id,
    players: [host],
    game: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pausedForSummary: false,
    botDelayMs: BOT_DELAY_MS,
    scores: {},
    matchMode: 'target',
    matchTarget: 100,
    matchHands: 3,
    handsPlayed: 0,
    matchWinnerId: null,
  }
  rooms.set(code, room)
  saveRoom(room)
  return { room, host }
}

export function joinRoom(
  code: string,
  name: string,
): { ok: true; room: Room; player: RoomPlayer } | { ok: false; error: string } {
  const room = rooms.get(code.toUpperCase())
  if (!room) return { ok: false, error: 'Room not found' }
  if (room.game) return { ok: false, error: 'Game already in progress' }
  if (room.players.length >= 4) return { ok: false, error: 'Room is full' }
  if (room.players.some((p) => !p.isBot && p.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Name already taken' }
  }
  const player = newRoomPlayer(name, false, 'medium')
  room.players.push(player)
  touch(room)
  saveRoom(room)
  return { ok: true, room, player }
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase())
}

export function getRoomBySocket(socketId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room
  }
  return undefined
}

export function findPlayerByToken(token: string): { room: Room; player: RoomPlayer } | null {
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.reconnectToken === token)
    if (player) return { room, player }
  }
  return null
}

export function touch(room: Room): void {
  room.updatedAt = Date.now()
}

export function save(room: Room): void {
  room.updatedAt = Date.now()
  saveRoom(room)
}

// Socket.IO instance, injected from index.ts on startup.
let io: any = null
export function setIo(instance: any): void {
  io = instance
}

// Broadcast to all players with a live socket; skips null socketIds
// (disconnected-but-kept players) to avoid Socket.IO errors. `exceptSocketId`
// lets handlers send a personalized event to one socket first and only fan
// out to the rest (so the personalized payload is not overwritten).
export function broadcastRoom(room: Room, event: string, data: unknown, exceptSocketId?: string): void {
  if (!io) return
  for (const p of room.players) {
    if (p.socketId && p.socketId !== exceptSocketId) {
      const socket = io.sockets.sockets.get(p.socketId)
      if (socket) socket.emit(event, data)
    }
  }
}

export function cleanupRooms(): void {
  const now = Date.now()
  for (const [code, room] of rooms) {
    const allDisconnected =
      room.players.length > 0 && room.players.every((p) => p.disconnected || p.socketId === null)
    const stale = now - room.updatedAt > ROOM_TTL_MS
    if (allDisconnected || stale) {
      rooms.delete(code)
      deleteRoom(code)
    }
  }
}

export function restorePersistedRooms(): void {
  for (const room of loadRooms()) {
    // Only restore rooms that look alive (recent activity)
    if (Date.now() - room.updatedAt < ROOM_TTL_MS) {
      // Old persisted rooms predate cumulative scores — default them.
      room.scores = room.scores ?? {}
      room.matchMode = room.matchMode ?? 'target'
      room.matchTarget = room.matchTarget ?? 100
      room.matchHands = room.matchHands ?? 3
      room.handsPlayed = room.handsPlayed ?? 0
      room.matchWinnerId = room.matchWinnerId ?? null
      // Never restore a mid-summary pause — nobody is holding the overlay
      // after a server restart; the game should resume instead of stalling.
      room.pausedForSummary = false
      // Socket IDs are meaningless across a restart (they reference dead
      // sockets). Clear them so reconnect by token is not rejected as
      // "already connected".
      for (const p of room.players) {
        if (!p.isBot) {
          p.socketId = null
          p.disconnected = true
        }
      }
      rooms.set(room.code, room)
    } else {
      deleteRoom(room.code)
    }
  }
}

export function roomCount(): number {
  return rooms.size
}

export function connectedPlayerCount(): number {
  let n = 0
  for (const room of rooms.values()) {
    for (const p of room.players) {
      if (!p.isBot && p.socketId != null) n += 1
    }
  }
  return n
}

export function maxRooms(): number {
  return MAX_ROOMS
}

// Keep the module-alive timer here so index.ts can start it once.
export function startCleanupTimer(): NodeJS.Timeout {
  return setInterval(cleanupRooms, CLEANUP_INTERVAL_MS)
}

export { rooms }
