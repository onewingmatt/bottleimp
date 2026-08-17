// Smoke test — drives a full game through the socket layer.
// Requires the server running on :3001.
import { io } from 'socket.io-client'

const URL = process.env.URL ?? 'http://localhost:3001'

function client() {
  const s = io(URL, { transports: ['websocket'] })
  const state = { board: null, room: null, scored: null }
  s.on('game:board', ({ game }) => { state.board = game })
  s.on('game:scored', ({ game, results }) => { state.board = game; state.scored = results })
  s.on('room:state', (room) => { state.room = room })
  return { s, state }
}

function once(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    socket.once(event, (data) => {
      clearTimeout(t)
      resolve(data)
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Wait until the given socket's stored board phase matches, with timeout.
async function waitPhase(c, phase, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (c.state.board?.phase === phase) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for phase ${phase}, current ${c.state.board?.phase}`)
}

async function main() {
  const host = client()
  await once(host.s, 'connect')
  host.s.emit('room:create', { playerName: 'Host' })
  await sleep(300)
  const code = host.state.room.code
  const hostId = host.state.room.yourId
  console.log('created room', code, 'host', hostId)

  const p2 = client()
  await once(p2.s, 'connect')
  p2.s.emit('room:join', { code, playerName: 'P2' })
  await sleep(300)
  const p2Id = p2.state.room.yourId
  console.log('joined', p2Id)

  host.s.emit('add_bot', { difficulty: 'easy' })
  await sleep(200)
  host.s.emit('add_bot', { difficulty: 'hard' })
  await sleep(300)
  console.log('room players:', host.state.room.players.map((p) => `${p.name}${p.isBot ? '(bot)' : ''}`))

  host.s.emit('game:start')
  await waitPhase(host, 'discard', 5000)
  console.log('game started, phase:', host.state.board.phase, 'players:', host.state.board.players.length)

  // --- Play through ---
  let guard = 0
  let discarded = { h: false, p: false }
  let passed = false
  while (guard++ < 600) {
    const board = host.state.board
    if (!board) { await sleep(50); continue }
    const phase = board.phase
    if (phase === 'hand_over' || phase === 'game_over') break

    if (phase === 'discard') {
      const actorId = board.playerOrder[board.currentPlayerIndex]
      if (actorId === hostId) {
        if (!discarded.h) {
          const hand = host.state.board.players.find((p) => p.id === actorId)?.hand ?? []
          host.s.emit('game:discard', { cardId: hand[0].id })
          discarded.h = true
        }
        await sleep(300)
        continue
      }
      if (actorId === p2Id) {
        if (!discarded.p) {
          const hand = p2.state.board.players.find((p) => p.id === actorId)?.hand ?? []
          p2.s.emit('game:discard', { cardId: hand[0].id })
          discarded.p = true
        }
        await sleep(300)
        continue
      }
      // bot's turn — scheduler acts
      await sleep(400)
      continue
    }

    if (phase === 'exchange') {
      if (!passed) {
        const hHand = host.state.board.players.find((p) => p.id === hostId)?.hand ?? []
        const pHand = p2.state.board.players.find((p) => p.id === p2Id)?.hand ?? []
        const hSorted = [...hHand].sort((a, b) => a.number - b.number)
        const pSorted = [...pHand].sort((a, b) => a.number - b.number)
        if (hHand.length >= 2) host.s.emit('game:pass', { leftCardId: hSorted[0].id, rightCardId: hSorted[1].id })
        if (pHand.length >= 2) p2.s.emit('game:pass', { leftCardId: pSorted[0].id, rightCardId: pSorted[1].id })
        passed = true
      }
      await sleep(300)
      continue
    }

    if (phase === 'playing') {
      const trick = board.currentTrick
      if (!trick) { await sleep(100); continue }
      const n = board.players.length
      const leaderIdx = board.playerOrder.indexOf(trick.leaderId)
      const playIdx = trick.plays.length
      const actorId = board.playerOrder[(leaderIdx + playIdx) % n]

      const source = actorId === hostId ? host : actorId === p2Id ? p2 : null
      if (source) {
        const hand = source.state.board.players.find((p) => p.id === actorId)?.hand ?? []
        const lead = trick.plays[0]
        const legal = lead
          ? (hand.filter((c) => c.suit === lead.card.suit).length > 0
              ? hand.filter((c) => c.suit === lead.card.suit)
              : hand)
          : hand
        if (legal.length === 0) { await sleep(100); continue }
        source.s.emit('game:play', { cardId: legal[0].id })
        await sleep(250)
        continue
      }
      // Bot's turn
      await sleep(400)
      continue
    }

    console.error('unexpected phase', phase)
    break
  }

  const finalPhase = host.state.board?.phase
  console.log('final phase:', finalPhase)
  if (finalPhase === 'hand_over' || finalPhase === 'game_over') {
    const results = host.state.scored ?? (await once(host.s, 'game:scored')).results
    console.log('results:', results.map((r) => `${r.playerId}: ${r.score}${r.heldBottle ? ' (bottle)' : ''}`))
    console.log('SMOKE TEST PASSED')
    host.s.close()
    p2.s.close()
    process.exit(0)
  } else {
    console.error('game did not finish, phase =', finalPhase)
    host.s.close()
    p2.s.close()
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED:', e.message)
  process.exit(1)
})
