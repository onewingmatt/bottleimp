// Match test — target-score sessions through the socket layer.
// - set a low target (10) so one hand almost surely crosses it
// - totals accumulate across hands
// - first player past the target => phase game_over + matchWinnerId
// - game:restart after game_over starts a NEW match with totals reset
// Requires the server running on :3001.
import { io } from 'socket.io-client'
import Database from 'better-sqlite3'

const URL = process.env.URL ?? 'http://localhost:3001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function client() {
  const s = io(URL, { transports: ['websocket'] })
  const state = { board: null, room: null, scored: null, scoredMeta: null }
  s.on('game:board', ({ game }) => { state.board = game })
  s.on('game:scored', ({ game, results, totals, matchWinnerId, matchTarget }) => {
    state.board = game
    state.scored = results
    state.scoredMeta = { totals, matchWinnerId, matchTarget }
  })
  s.on('room:state', (room) => { state.room = room })
  s.on('error', ({ message }) => console.log('  [err]', message))
  return { s, state }
}

function once(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    socket.once(event, (data) => { clearTimeout(t); resolve(data) })
  })
}

async function waitPhase(c, phase, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (c.state.board?.phase === phase) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for phase ${phase}, current ${c.state.board?.phase}`)
}

// Drive the human's turns (same logic as smoke.mjs) until hand_over or
// game_over is reached; returns the final board phase. Passes once per hand.
async function playUntil(c, hostId, timeoutMs = 90000) {
  const start = Date.now()
  let passed = false
  let discarded = false
  let guard = 0
  while (Date.now() - start < timeoutMs && guard++ < 4000) {
    const board = c.state.board
    if (!board) { await sleep(50); continue }
    const phase = board.phase
    if (phase === 'hand_over' || phase === 'game_over') return phase
    if (phase === 'discard') {
      const actorId = board.playerOrder[board.currentPlayerIndex]
      if (actorId === hostId && !discarded) {
        const hand = board.players.find((p) => p.id === actorId)?.hand ?? []
        if (hand.length > 0) {
          c.s.emit('game:discard', { cardId: hand[0].id })
          discarded = true
        }
      }
      await sleep(90)
      continue
    }
    if (phase === 'exchange') {
      if (!passed) {
        const hand = board.players.find((p) => p.id === hostId)?.hand ?? []
        const sorted = [...hand].sort((a, b) => a.number - b.number)
        if (hand.length >= 2) {
          c.s.emit('game:pass', { leftCardId: sorted[0].id, rightCardId: sorted[1].id })
          passed = true
        }
      }
      await sleep(90)
      continue
    }
    if (phase === 'playing') {
      const trick = board.currentTrick
      if (!trick) { await sleep(50); continue }
      const n = board.players.length
      const leaderIdx = board.playerOrder.indexOf(trick.leaderId)
      const playIdx = trick.plays.length
      const actorId = board.playerOrder[(leaderIdx + playIdx) % n]
      if (actorId === hostId) {
        const hand = board.players.find((p) => p.id === actorId)?.hand ?? []
        const lead = trick.plays[0]
        const legal = lead
          ? (hand.filter((c) => c.suit === lead.card.suit).length > 0
              ? hand.filter((c) => c.suit === lead.card.suit)
              : hand)
          : hand
        if (legal.length > 0) c.s.emit('game:play', { cardId: legal[0].id })
      }
      await sleep(60)
      continue
    }
    await sleep(50)
  }
  throw new Error(`did not reach hand_over/game_over, last phase ${c.state.board?.phase}`)
}

function dbRoom(code) {
  const db = new Database(process.env.DB_PATH ?? 'data/bottleimp.db')
  db.pragma('query_only = ON')
  const row = db.prepare('SELECT data FROM rooms WHERE code = ?').get(code)
  db.close()
  return row ? JSON.parse(row.data) : null
}

async function main() {
  const host = client()
  await once(host.s, 'connect')
  host.s.emit('room:create', { playerName: 'Match' })
  await sleep(300)
  const code = host.state.room.code
  const hostId = host.state.room.yourId
  console.log('room', code, 'default target =', host.state.room.matchTarget)

  if (host.state.room.matchTarget !== 100) throw new Error('expected default target 100')

  host.s.emit('game:setMatch', { mode: 'target', target: 10 })
  await sleep(300)
  console.log('target after set:', host.state.room.matchTarget)
  if (host.state.room.matchTarget !== 10) throw new Error('setMatch did not apply target')

  host.s.emit('game:setMatch', { mode: 'target', target: 0 }) // out of range
  await sleep(300)
  console.log('target after invalid set (stays):', host.state.room.matchTarget)

  host.s.emit('add_bot', { difficulty: 'medium' })
  host.s.emit('add_bot', { difficulty: 'medium' })
  host.s.emit('add_bot', { difficulty: 'hard' })
  await sleep(400)
  host.s.emit('game:setSpeed', { fast: true })
  host.s.emit('game:start')
  await waitPhase(host, 'discard', 8000)
  console.log('match started (1 human + 3 bots), phase', host.state.board.phase)

  // Hand 1
  await playUntil(host, hostId)
  let totals = host.state.scoredMeta?.totals ?? {}
  console.log('hand 1 totals:', JSON.stringify(totals))
  console.log('phase after hand 1:', host.state.board.phase, ' winner:', host.state.scoredMeta?.matchWinnerId)
  if (Object.values(totals).length !== 4) throw new Error('totals missing players after hand 1')

  // If nobody crossed 10 (unlikely), run more hands.
  let handsPlayed = 1
  while (host.state.board.phase !== 'game_over' && handsPlayed < 5) {
    host.s.emit('game:restart')
    await waitPhase(host, 'discard', 8000)
    await playUntil(host, hostId)
    handsPlayed++
    totals = host.state.scoredMeta?.totals ?? {}
    console.log(`hand ${handsPlayed} totals:`, JSON.stringify(totals))
  }

  console.log('match ended after', handsPlayed, 'hands; phase', host.state.board.phase)
  if (host.state.board.phase !== 'game_over') throw new Error('match did not end in game_over')
  const winnerId = host.state.scoredMeta?.matchWinnerId
  if (!winnerId) throw new Error('matchWinnerId missing after match end')
  const winnerScore = totals[winnerId]
  if (winnerScore < 10) throw new Error(`winner ${winnerId} total ${winnerScore} below target 10`)

  const dbBefore = dbRoom(code)
  if (dbBefore.matchWinnerId !== winnerId) throw new Error('matchWinnerId not persisted')
  console.log('winner', winnerId, 'at', winnerScore, '— game_over + persisted OK')

  // New match: restart resets totals + winner.
  host.s.emit('game:restart')
  await waitPhase(host, 'discard', 8000)
  const dbAfter = dbRoom(code)
  console.log('after restart: scores =', JSON.stringify(dbAfter.scores), ' winner =', dbAfter.matchWinnerId)
  if (Object.keys(dbAfter.scores).length !== 0) throw new Error('new match did not reset totals')
  if (dbAfter.matchWinnerId !== null) throw new Error('new match did not clear winner')

  console.log('MATCH TEST PASSED')
  host.s.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('MATCH TEST FAILED:', e.message)
  process.exit(1)
})