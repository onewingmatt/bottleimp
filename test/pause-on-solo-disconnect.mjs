// Pause-on-solo-disconnect test (DB-verified).
// 1 human + 3 bots. Human disconnects mid-hand while a BOT is acting.
// While disconnected: the room must NOT advance — no bot takeover, no bot
// actions. The server persists every mutation to SQLite; if the game advanced
// while the human was away, the stored game JSON would change. Reconnect must
// clear the freeze and make the game live again.
import { io } from 'socket.io-client'
import Database from 'better-sqlite3'

const URL = process.env.URL ?? 'http://localhost:3001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function client() {
  const s = io(URL, { transports: ['websocket'] })
  const state = { board: null, room: null }
  s.on('game:board', ({ game }) => { state.board = game })
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

async function actorOf(board) {
  const trick = board.currentTrick
  const n = board.players.length
  const leaderIdx = board.playerOrder.indexOf(trick.leaderId)
  const playIdx = trick.plays.length
  return board.playerOrder[(leaderIdx + playIdx) % n]
}

function dbGame(code) {
  const db = new Database('data/bottleimp.db', { readonly: true })
  const row = db.prepare('SELECT data FROM rooms WHERE code = ?').get(code)
  db.close()
  return row ? JSON.parse(row.data) : null
}

async function main() {
  const host = client()
  await once(host.s, 'connect')
  host.s.emit('room:create', { playerName: 'Solo' })
  await sleep(300)
  const code = host.state.room.code
  const hostId = host.state.room.yourId
  const token = host.state.room.reconnectToken
  console.log('room', code, 'host', hostId)

  for (let i = 0; i < 3; i++) {
    host.s.emit('add_bot', { difficulty: 'medium' })
    await sleep(150)
  }
  host.s.emit('game:start')
  await waitPhase(host, 'discard', 5000)

  // Reach the playing phase, playing only when it's the human's turn, until a
  // BOT is the actor — then disconnect so the freeze is provable.
  let disc = false
  let pass = false
  let guard = 0
  while (guard++ < 400) {
    const board = host.state.board
    if (!board) { await sleep(50); continue }
    if (board.phase === 'discard') {
      const actor = board.playerOrder[board.currentPlayerIndex]
      if (actor === hostId && !disc) {
        const hand = board.players.find((p) => p.id === hostId)?.hand ?? []
        if (hand.length > 0) { host.s.emit('game:discard', { cardId: hand[0].id }); disc = true }
      }
      await sleep(150); continue
    }
    if (board.phase === 'exchange') {
      if (!pass) {
        const hand = board.players.find((p) => p.id === hostId)?.hand ?? []
        const sorted = [...hand].sort((a, b) => a.number - b.number)
        if (sorted.length >= 2) {
          host.s.emit('game:pass', { leftCardId: sorted[0].id, rightCardId: sorted[1].id })
          pass = true
        }
      }
      await sleep(150); continue
    }
    if (board.phase === 'playing') {
      const actor = await actorOf(board)
      if (actor !== hostId) {
        console.log('bot turn reached:', actor, '- disconnecting human now')
        break
      }
      const hand = board.players.find((p) => p.id === hostId)?.hand ?? []
      const lead = board.currentTrick?.plays[0]
      const legal = lead
        ? (hand.filter((c) => c.suit === lead.card.suit).length > 0
            ? hand.filter((c) => c.suit === lead.card.suit)
            : hand)
        : hand
      if (legal.length > 0) host.s.emit('game:play', { cardId: legal[0].id })
      await sleep(180); continue
    }
    break
  }

  // Disconnect the human mid-bot-turn.
  host.s.disconnect()
  await sleep(300)
  const db1 = dbGame(code)
  const s1 = JSON.stringify(db1.game)
  console.log('disconnected; db snapshot taken')

  await sleep(2500) // 20+ bot-delay windows (120ms each)

  const db2 = dbGame(code)
  const s2 = JSON.stringify(db2.game)
  const frozen = s1 === s2
  console.log('FROZEN while away (db identical over 2.5s):', frozen)
  if (!frozen) {
    console.log('TEST FAILED: room advanced while solo human away')
    process.exit(1)
  }

  // Reconnect by token — flag clears, game resumes.
  const back = client()
  await once(back.s, 'connect')
  back.s.emit('room:reconnect', { reconnectToken: token })
  await sleep(600)
  console.log('board restored after reconnect:', !!back.state.board)

  // Play the human's move if it's their turn, then verify the game moves again.
  if (back.state.board?.phase === 'playing') {
    const actor = await actorOf(back.state.board)
    if (actor === hostId) {
      const hand = back.state.board.players.find((p) => p.id === hostId)?.hand ?? []
      const lead = back.state.board.currentTrick?.plays[0]
      const legal = lead
        ? (hand.filter((c) => c.suit === lead.card.suit).length > 0
            ? hand.filter((c) => c.suit === lead.card.suit)
            : hand)
        : hand
      if (legal.length > 0) back.s.emit('game:play', { cardId: legal[0].id })
    }
  }
  await sleep(900)
  const db3 = dbGame(code)
  const s3 = JSON.stringify(db3.game)
  const resumed = s3 !== s2
  console.log('game resumed after reconnect:', resumed)
  if (!resumed) {
    console.log('TEST FAILED: game did not resume after reconnect')
    process.exit(1)
  }
  console.log('PAUSE+RESUME TEST PASSED')
  host.s.close()
  back.s.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('TEST FAILED:', e.message)
  process.exit(1)
})