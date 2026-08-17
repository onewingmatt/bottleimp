// Best-of-N match test — hands mode through the socket layer.
// - set matchMode 'hands', 2 hands
// - play hand 1 -> hand_over, no winner (match not over)
// - play hand 2 -> game_over, winner = highest running total
// - totals accumulate across the two hands
// Requires the server running on :3001.
import { io } from 'socket.io-client'
import Database from 'better-sqlite3'

const URL = process.env.URL ?? 'http://localhost:3001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function client() {
  const s = io(URL, { transports: ['websocket'] })
  const state = { board: null, room: null, scored: null, scoredMeta: null }
  s.on('game:board', ({ game }) => { state.board = game })
  s.on('game:scored', ({ game, results, totals, matchWinnerId, matchTarget, matchMode, matchHands, handsPlayed }) => {
    state.board = game
    state.scored = results
    state.scoredMeta = { totals, matchWinnerId, matchTarget, matchMode, matchHands, handsPlayed }
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

async function main() {
  const host = client()
  await once(host.s, 'connect')
  host.s.emit('room:create', { playerName: 'BestOf' })
  await sleep(300)
  const code = host.state.room.code
  const hostId = host.state.room.yourId

  if (host.state.room.matchMode !== 'target') throw new Error('expected default mode target')
  host.s.emit('game:setMatch', { mode: 'hands', hands: 2 })
  await sleep(300)
  console.log('mode:', host.state.room.matchMode, 'hands:', host.state.room.matchHands)
  if (host.state.room.matchMode !== 'hands' || host.state.room.matchHands !== 2) {
    throw new Error('setMatch hands did not apply')
  }

  host.s.emit('game:setMatch', { mode: 'hands', hands: 0 }) // out of range
  await sleep(300)
  console.log('hands after invalid set (stays):', host.state.room.matchHands)
  if (host.state.room.matchHands !== 2) throw new Error('invalid hands value was accepted')

  host.s.emit('add_bot', { difficulty: 'medium' })
  host.s.emit('add_bot', { difficulty: 'medium' })
  host.s.emit('add_bot', { difficulty: 'hard' })
  await sleep(400)
  host.s.emit('game:setSpeed', { fast: true })
  host.s.emit('game:start')
  await waitPhase(host, 'discard', 8000)

  // Hand 1: must NOT end the match.
  await playUntil(host, hostId)
  console.log('hand 1: phase', host.state.board.phase, 'winner', host.state.scoredMeta?.matchWinnerId)
  if (host.state.board.phase !== 'hand_over') throw new Error('hand 1 should not end the match')
  if (host.state.scoredMeta?.matchWinnerId != null) throw new Error('match winner set before hands exhausted')
  if (host.state.scoredMeta?.handsPlayed !== 1) throw new Error('handsPlayed should be 1 after hand 1')
  const totals1 = { ...host.state.scoredMeta.totals }
  console.log('hand 1 totals:', JSON.stringify(totals1))

  // Hand 2: match ends, winner = highest running total.
  host.s.emit('game:restart')
  await waitPhase(host, 'discard', 8000)
  await playUntil(host, hostId)
  console.log('hand 2: phase', host.state.board.phase, 'winner', host.state.scoredMeta?.matchWinnerId)
  if (host.state.board.phase !== 'game_over') throw new Error('hand 2 should end the match')
  const meta = host.state.scoredMeta
  if (meta.handsPlayed !== 2) throw new Error('handsPlayed should be 2 after hand 2')
  const totals = meta.totals
  const winnerId = meta.matchWinnerId
  if (!winnerId) throw new Error('no match winner after hands exhausted')
  const all = Object.values(totals)
  if (totals[winnerId] !== Math.max(...all)) throw new Error('winner is not the highest total')
  console.log('totals:', JSON.stringify(totals), '-> winner', winnerId, 'at', totals[winnerId])

  // Persisted state: winner + handsPlayed survive.
  const db = new Database(process.env.DB_PATH ?? 'data/bottleimp.db', { readonly: true })
  const row = db.prepare('SELECT data FROM rooms WHERE code = ?').get(code)
  db.close()
  const persisted = JSON.parse(row.data)
  if (persisted.matchWinnerId !== winnerId) throw new Error('matchWinnerId not persisted')
  if (persisted.handsPlayed !== 2) throw new Error('handsPlayed not persisted')

  // New match resets handsPlayed + totals.
  host.s.emit('game:restart')
  await waitPhase(host, 'discard', 8000)
  const db2 = new Database(process.env.DB_PATH ?? 'data/bottleimp.db', { readonly: true })
  const row2 = db2.prepare('SELECT data FROM rooms WHERE code = ?').get(code)
  db2.close()
  const p2 = JSON.parse(row2.data)
  console.log('after restart: scores =', JSON.stringify(p2.scores), 'winner =', p2.matchWinnerId, 'handsPlayed =', p2.handsPlayed)
  if (Object.keys(p2.scores).length !== 0) throw new Error('new match did not reset totals')
  if (p2.matchWinnerId !== null) throw new Error('new match did not clear winner')
  if (p2.handsPlayed !== 0) throw new Error('new match did not reset handsPlayed')

  console.log('BESTOF TEST PASSED')
  host.s.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('BESTOF TEST FAILED:', e.message)
  process.exit(1)
})