// Socket.IO event handlers. Server-authoritative: all validation lives in the
// engine; handlers just auth the player, call the engine, and broadcast.
import type { Server, Socket } from 'socket.io'
import { createGame, discardCard, passCards, playCard } from '../shared/engine'
import { scoreHand } from '../shared/scoring'
import { botAction } from '../shared/bot'
import type { ActionResult, GameState } from '../shared/types'
import {
  type Room,
  broadcastRoom,
  createRoom,
  findPlayerByToken,
  getRoom,
  getRoomBySocket,
  joinRoom,
  newRoomPlayer,
  rooms,
  save,
} from './rooms'
import { deleteRoom } from './db'
import { clearBotTimer, BOT_DELAY_MS, FAST_BOT_DELAY_MS, scheduleBot, setOnAfterMutation } from './botScheduler'

const MIN_PLAYERS = Number(process.env.MIN_PLAYERS ?? 3)
const MAX_PLAYERS = 4

// Strip hidden state (other players' hands, imp trick identity) before
// sending to a specific client. The client only ever sees its own hand.
function serializeGame(g: GameState, forPlayerId: string) {
  return {
    ...g,
    players: g.players.map((p) => ({
      id: p.id,
      name: p.name,
      // Only this client sees its own cards; others see just a count.
      hand: p.id === forPlayerId ? p.hand : undefined,
      handCount: p.hand.length,
      tricksWon: p.tricksWon.map((trick) => trick.map((c) => c)),
      disconnected: p.disconnected,
      isBot: p.isBot,
      difficulty: p.difficulty,
    })),
    // The Imp's Trick (discards under the 19) is hidden until scoring.
    impTrick: g.phase === 'hand_over' || g.phase === 'game_over' ? g.impTrick : undefined,
    impTrickCount: g.impTrick.length,
    incoming: undefined, // exchange staging is server-internal
    finalResults: g.finalResults ?? undefined,
  }
}

function roomPublic(room: Room) {
  return {
    code: room.code,
    hostId: room.hostId,
    inGame: !!room.game,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      difficulty: p.difficulty,
      disconnected: p.disconnected,
    })),
  }
}

// True when at least one human player has a live socket.
function hasConnectedHuman(room: Room): boolean {
  return room.players.some((p) => !p.isBot && p.socketId != null)
}

// Advance the game past any player whose turn it currently is but who has
// disconnected. The engine refuses actions from disconnected players, so
// without this a mid-game disconnect on your turn would stall the room.
// Auto-plays them legally using the bot decision function (bot takeover).
function advancePastDisconnected(room: Room): boolean {
  let moved = false
  let guard = 0
  while (guard++ < 64) {
    const g = room.game
    if (!g) return moved
    let actorId: string | null = null
    if (g.phase === 'discard') actorId = g.playerOrder[g.currentPlayerIndex] ?? null
    else if (g.phase === 'exchange') {
      const uncommitted = g.players.find((p) => !(p.passedLeft && p.passedRight))
      actorId = uncommitted?.id ?? null
    } else if (g.phase === 'playing' && g.currentTrick) {
      const trick = g.currentTrick
      const n = g.players.length
      const leaderIdx = g.playerOrder.indexOf(trick.leaderId)
      const playIdx = trick.plays.length
      actorId = g.playerOrder[(leaderIdx + playIdx) % n] ?? null
    } else {
      return moved
    }
    if (!actorId) return moved
    const rp = room.players.find((p) => p.id === actorId)
    if (!rp || !rp.disconnected) return moved
    const gp = g.players.find((p) => p.id === actorId)
    if (!gp) return moved
    // The engine clones state, so flipping the flag must happen on the state
    // we feed IN, and be restored on the state we get OUT.
    gp.disconnected = false // engine blocks actions from disconnected players
    let result: ActionResult | null = null
    // Use the bot decision for the disconnected human (bot takeover).
    try {
      const difficulty = rp.isBot ? rp.difficulty ?? 'medium' : 'medium'
      const action = botAction(g, actorId, difficulty, Math.random)
      if (g.phase === 'discard') result = discardCard(g, actorId, action.kind === 'discard' ? action.cardId : gp.hand[0].id)
      else if (g.phase === 'exchange') {
        if (action.kind === 'pass') result = passCards(g, actorId, action.leftCardId, action.rightCardId)
        else if (gp.hand.length >= 2) result = passCards(g, actorId, gp.hand[0].id, gp.hand[1].id)
      } else if (g.phase === 'playing') {
        if (action.kind === 'play') result = playCard(g, actorId, action.cardId)
      }
    } catch {
      // fallthrough to safe fallback
    }
    if (!result || !result.ok) {
      // Safe fallback
      if (g.phase === 'discard' && gp.hand.length > 0) result = discardCard(g, actorId, gp.hand[0].id)
      else if (g.phase === 'exchange' && gp.hand.length >= 2) result = passCards(g, actorId, gp.hand[0].id, gp.hand[1].id)
      else if (g.phase === 'playing') {
        const trick = g.currentTrick
        if (trick && gp.hand.length > 0) {
          const leaderPlay = trick.plays[0]
          const legal = leaderPlay
            ? (gp.hand.filter((c) => c.suit === leaderPlay.card.suit).length > 0
                ? gp.hand.filter((c) => c.suit === leaderPlay.card.suit)
                : gp.hand)
            : gp.hand
          if (legal.length > 0) result = playCard(g, actorId, legal[0].id)
        }
      }
    }
    if (!result || !result.ok) return moved
    room.game = result.state
    const restored = room.game.players.find((p) => p.id === actorId)
    if (restored) restored.disconnected = true
    moved = true
  }
  return moved
}

// Keep the engine's player flag in sync with the room's.
function syncGameDisconnected(room: Room, playerId: string, value: boolean): void {
  const gp = room.game?.players.find((p) => p.id === playerId)
  if (gp) gp.disconnected = value
}

// The single post-mutation choke point: persist → broadcast → score →
// schedule next bot.
function afterMutation(room: Room): void {
  // A mutation may have advanced the turn to a disconnected player. Skip them
  // before broadcasting so play never stalls on an absent player.
  if (room.game) advancePastDisconnected(room)
  save(room)
  if (!room.game) return
  const g = room.game
  // Broadcast a per-player view (each client sees only its own hand).
  for (const p of room.players) {
    if (p.socketId) {
      const socket = io.sockets.sockets.get(p.socketId)
      if (socket) {
        socket.emit('game:board', { game: serializeGame(g, p.id) })
      }
    }
  }

  if (g.phase === 'hand_over') {
    const scored = scoreHand(g)
    // Guard against double-scoring: afterMutation can re-run on leave/disconnect
    // while the summary is up. finalResults is set only on the first pass.
    if (!g.finalResults) {
      g.finalResults = scored
      // Add this hand's scores to the running room totals (persisted with the
      // room, so totals survive server restarts and reconnects).
      for (const line of scored) {
        room.scores[line.playerId] = (room.scores[line.playerId] ?? 0) + line.score
      }
    }
    // broadcast final results to everyone
    for (const p of room.players) {
      if (p.socketId) {
        const socket = io.sockets.sockets.get(p.socketId)
        if (socket) {
          socket.emit('game:scored', {
            game: serializeGame(g, p.id),
            results: scored,
            totals: { ...room.scores },
          })
        }
      }
    }
    if (hasConnectedHuman(room)) {
      room.pausedForSummary = true
      clearBotTimer(room.code)
      save(room)
    }
    return
  }
  scheduleBot(room)
}

let io: any = null

export function registerHandlers(server: Server): void {
  io = server
  setOnAfterMutation(afterMutation)
  server.on('connection', (socket: Socket) => {
    // ------------------------------------------------------------------
    // Lobby
    // ------------------------------------------------------------------
    socket.on('room:create', ({ playerName } = {}) => {
      const name = String(playerName ?? '').trim().slice(0, 24) || 'Player'
      const { room, host } = createRoom(name)
      host.socketId = socket.id
      save(room)
      socket.emit('room:state', {
        ...roomPublic(room),
        reconnectToken: host.reconnectToken,
        yourId: host.id,
      })
      broadcastRoom(room, 'room:state', roomPublic(room), socket.id)
    })

    socket.on('room:join', ({ code, playerName } = {}) => {
      const name = String(playerName ?? '').trim().slice(0, 24) || 'Player'
      const res = joinRoom(String(code ?? ''), name)
      if (!res.ok) {
        socket.emit('error', { message: res.error })
        return
      }
      res.player.socketId = socket.id
      save(res.room)
      socket.emit('room:state', {
        ...roomPublic(res.room),
        reconnectToken: res.player.reconnectToken,
        yourId: res.player.id,
      })
      broadcastRoom(res.room, 'room:state', roomPublic(res.room), socket.id)
    })

    socket.on('room:reconnect', ({ reconnectToken } = {}) => {
      const found = findPlayerByToken(String(reconnectToken ?? ''))
      if (!found) return // stale token — fail silently
      const { room, player } = found
      if (player.socketId && player.socketId !== socket.id) {
        socket.emit('error', { message: 'This player is already connected' })
        return
      }
      player.socketId = socket.id
      player.disconnected = false
      syncGameDisconnected(room, player.id, false)
      room.pausedForSummary = false
      save(room)
      socket.emit('room:state', {
        ...roomPublic(room),
        reconnectToken: player.reconnectToken,
        yourId: player.id,
      })
      if (room.game) {
        const g = room.game
        socket.emit('game:board', { game: serializeGame(g, player.id) })
        if (g.phase === 'hand_over' || g.phase === 'game_over') {
          const scored = scoreHand(g)
          socket.emit('game:scored', {
            game: serializeGame(g, player.id),
            results: scored,
            totals: { ...room.scores },
          })
        }
      }
      broadcastRoom(room, 'room:state', roomPublic(room), socket.id)
      scheduleBot(room)
    })

    socket.on('room:leave', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      const player = room.players.find((p) => p.socketId === socket.id)
      if (!player) return
      if (!room.game) {
        room.players = room.players.filter((p) => p.id !== player.id)
        if (room.players.length === 0) {
          // room gets cleaned by the cleanup timer
        } else if (room.hostId === player.id) {
          room.hostId = room.players[0].id
        }
        save(room)
        broadcastRoom(room, 'room:state', roomPublic(room))
        socket.emit('room:left')
      } else {
        player.socketId = null
        player.disconnected = true
        syncGameDisconnected(room, player.id, true)
        save(room)
        broadcastRoom(room, 'room:state', roomPublic(room))
        socket.emit('room:left')
        if (!hasConnectedHuman(room)) room.pausedForSummary = false
        afterMutation(room)
      }
    })

    socket.on('room:close', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      const player = room.players.find((p) => p.socketId === socket.id)
      if (!player || player.id !== room.hostId) return
      for (const p of room.players) {
        if (p.socketId) {
          const s = io.sockets.sockets.get(p.socketId)
          if (s) s.emit('room:closed')
        }
      }
      rooms.delete(room.code)
      deleteRoom(room.code)
    })

    socket.on('add_bot', ({ difficulty } = {}) => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      if (room.game) {
        socket.emit('error', { message: 'Game already started' })
        return
      }
      if (room.players.length >= MAX_PLAYERS) {
        socket.emit('error', { message: 'Room is full' })
        return
      }
      const d = difficulty === 'easy' || difficulty === 'hard' ? difficulty : 'medium'
      const bot = newRoomPlayer(`Bot ${room.players.filter((p) => p.isBot).length + 1}`, true, d)
      room.players.push(bot)
      save(room)
      broadcastRoom(room, 'room:state', roomPublic(room))
    })

    socket.on('remove_bot', ({ playerId } = {}) => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      if (room.game) return
      const bot = room.players.find((p) => p.id === playerId && p.isBot)
      if (bot) {
        room.players = room.players.filter((p) => p.id !== bot.id)
        save(room)
        broadcastRoom(room, 'room:state', roomPublic(room))
      }
    })

    // ------------------------------------------------------------------
    // Game
    // ------------------------------------------------------------------
    socket.on('game:start', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      if (room.game) {
        socket.emit('error', { message: 'Game already started' })
        return
      }
      if (room.players.length < MIN_PLAYERS) {
        socket.emit('error', { message: `Need at least ${MIN_PLAYERS} players` })
        return
      }
      room.game = createGame(
        room.players.map((p) => ({ id: p.id, name: p.name })),
        Math.random,
      )
      room.scores = {}
      for (let i = 0; i < room.players.length; i++) {
        const rp = room.players[i]
        const gp = room.game.players[i]
        if (gp && rp.isBot) {
          gp.isBot = true
          gp.difficulty = rp.difficulty
        }
        if (gp) gp.disconnected = rp.disconnected
      }
      save(room)
      broadcastRoom(room, 'room:state', roomPublic(room))
      afterMutation(room)
    })

    socket.on('game:discard', ({ cardId } = {}) => {
      const room = getRoomBySocket(socket.id)
      const player = room?.players.find((p) => p.socketId === socket.id)
      if (!room || !room.game || !player) return
      const res = discardCard(room.game, player.id, String(cardId ?? ''))
      if (!res.ok) {
        socket.emit('error', { message: res.error })
        return
      }
      room.game = res.state
      afterMutation(room)
    })

    socket.on('game:pass', ({ leftCardId, rightCardId } = {}) => {
      const room = getRoomBySocket(socket.id)
      const player = room?.players.find((p) => p.socketId === socket.id)
      if (!room || !room.game || !player) return
      const res = passCards(room.game, player.id, String(leftCardId ?? ''), String(rightCardId ?? ''))
      if (!res.ok) {
        socket.emit('error', { message: res.error })
        return
      }
      room.game = res.state
      afterMutation(room)
    })

    socket.on('game:play', ({ cardId } = {}) => {
      const room = getRoomBySocket(socket.id)
      const player = room?.players.find((p) => p.socketId === socket.id)
      if (!room || !room.game || !player) return
      const res = playCard(room.game, player.id, String(cardId ?? ''))
      if (!res.ok) {
        socket.emit('error', { message: res.error })
        return
      }
      room.game = res.state
      afterMutation(room)
    })

    socket.on('game:continue', () => {
      const room = getRoomBySocket(socket.id)
      if (!room || !room.game) return
      if (!room.pausedForSummary) return
      room.pausedForSummary = false
      save(room)
      scheduleBot(room)
    })

    socket.on('game:restart', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      if (!room.game || (room.game.phase !== 'hand_over' && room.game.phase !== 'game_over')) return
      room.game = createGame(
        room.players.map((p) => ({ id: p.id, name: p.name })),
        Math.random,
      )
      for (let i = 0; i < room.players.length; i++) {
        const rp = room.players[i]
        const gp = room.game.players[i]
        if (gp && rp.isBot) {
          gp.isBot = true
          gp.difficulty = rp.difficulty
        }
        if (gp) gp.disconnected = rp.disconnected
      }
      room.pausedForSummary = false
      save(room)
      afterMutation(room)
    })

    socket.on('game:setSpeed', ({ fast } = {}) => {
      const room = getRoomBySocket(socket.id)
      if (!room || !room.game) return
      const next = fast ? FAST_BOT_DELAY_MS : BOT_DELAY_MS
      if (room.botDelayMs === next) return
      room.botDelayMs = next
      save(room)
      clearBotTimer(room.code)
      scheduleBot(room)
    })

    // ------------------------------------------------------------------
    // Disconnect
    // ------------------------------------------------------------------
    socket.on('disconnect', () => {
      const room = getRoomBySocket(socket.id)
      if (!room) return
      const player = room.players.find((p) => p.socketId === socket.id)
      if (!player) return
      if (!room.game) {
        room.players = room.players.filter((p) => p.id !== player.id)
        if (room.hostId === player.id && room.players.length > 0) {
          room.hostId = room.players[0].id
        }
        save(room)
        broadcastRoom(room, 'room:state', roomPublic(room))
      } else {
        player.socketId = null
        player.disconnected = true
        syncGameDisconnected(room, player.id, true)
        save(room)
        broadcastRoom(room, 'room:state', roomPublic(room))
        if (!hasConnectedHuman(room)) room.pausedForSummary = false
        afterMutation(room)
      }
    })
  })
}
