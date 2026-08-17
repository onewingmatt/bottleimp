// Bot scheduler — setTimeout per bot action.
// CRITICAL: after every bot action (success or fallback), scheduleBot must run
// again so multi-bot games keep moving. afterMutation() in handlers.ts is the
// single choke point that guarantees this.
import { discardCard, passCards, playCard } from '../shared/engine'
import { botAction, isBotsTurn } from '../shared/bot'
import type { ActionResult } from '../shared/types'
import type { Room } from './rooms'

const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 800)
export { BOT_DELAY_MS }
export const FAST_BOT_DELAY_MS = 120
const botTimers = new Map<string, NodeJS.Timeout>()

// Hook called after a successful mutation (persist, broadcast).
// Defined by handlers.ts to avoid a circular import.
let onAfterMutation: (room: Room) => void = () => {}

export function setOnAfterMutation(fn: (room: Room) => void): void {
  onAfterMutation = fn
}

export function clearBotTimer(code: string): void {
  const t = botTimers.get(code)
  if (t) {
    clearTimeout(t)
    botTimers.delete(code)
  }
}

// If it is a bot's turn right now, schedule its action.
export function scheduleBot(room: Room): void {
  if (!room || !room.game) return
  // Summary overlay OR the last-human-away freeze: hold bot play.
  if (room.pausedForSummary || room.pausedForReconnect) return
  const g = room.game
  if (g.phase === 'discard') {
    const actor = g.players[g.currentPlayerIndex]
    if (!actor?.isBot) return
    schedule(room, actor.id)
    return
  }
  if (g.phase === 'exchange') {
    // Any uncommitted bot needs to commit its passes.
    const uncommitted = g.players.find((p) => p.isBot && !(p.passedLeft && p.passedRight))
    if (!uncommitted) return
    schedule(room, uncommitted.id)
    return
  }
  if (g.phase === 'playing') {
    // Find the actor of the current trick.
    const trick = g.currentTrick
    if (!trick) return
    const n = g.players.length
    const leaderIdx = g.playerOrder.indexOf(trick.leaderId)
    const playIdx = trick.plays.length
    const actor = g.players[(leaderIdx + playIdx) % n]
    if (!actor?.isBot) return
    schedule(room, actor.id)
    return
  }
}

function schedule(room: Room, botId: string): void {
  clearBotTimer(room.code)
  const delay = room.botDelayMs ?? BOT_DELAY_MS
  const timer = setTimeout(() => runBot(room, botId), delay)
  botTimers.set(room.code, timer)
}

// Perform one legal bot action. Falls back to a guaranteed-legal move so the
// game never stalls.
function runBot(room: Room, botId: string): void {
  botTimers.delete(room.code)
  const g = room.game
  if (!g) return
  const rp = room.players.find((p) => p.id === botId)
  if (!rp || !rp.isBot) return

  if (!isBotsTurn(g, botId)) {
    onAfterMutation(room)
    return
  }

  const difficulty = rp.difficulty ?? 'medium'
  const action = botAction(g, botId, difficulty, Math.random)

  let result: ActionResult
  if (action.kind === 'discard') result = discardCard(g, botId, action.cardId)
  else if (action.kind === 'pass') result = passCards(g, botId, action.leftCardId, action.rightCardId)
  else result = playCard(g, botId, action.cardId)

  if (!result.ok) {
    // Illegal move: force a safe legal move so play always advances.
    if (g.phase === 'discard') {
      const actor = g.players.find((p) => p.id === botId)
      if (actor && actor.hand.length > 0) {
        result = discardCard(g, botId, actor.hand[0].id)
      }
    } else if (g.phase === 'exchange') {
      const actor = g.players.find((p) => p.id === botId)
      if (actor && actor.hand.length >= 2) {
        result = passCards(g, botId, actor.hand[0].id, actor.hand[1].id)
      }
    } else if (g.phase === 'playing') {
      // Legal plays are guaranteed non-empty during a trick.
      const actor = g.players.find((p) => p.id === botId)
      const trick = g.currentTrick
      if (actor && trick) {
        const n = g.players.length
        const leaderIdx = g.playerOrder.indexOf(trick.leaderId)
        const playIdx = trick.plays.length
        const turn = g.players[(leaderIdx + playIdx) % n]
        if (turn?.id === botId) {
          const legal = (() => {
            const leaderPlay = trick.plays[0]
            if (!leaderPlay) return actor.hand.slice()
            const canFollow = actor.hand.filter((c) => c.suit === leaderPlay.card.suit)
            return canFollow.length > 0 ? canFollow : actor.hand.slice()
          })()
          if (legal.length > 0) result = playCard(g, botId, legal[0].id)
        }
      }
    }
  }

  if (result.ok) {
    room.game = result.state
  } else {
    // Both the chosen action and the fallback failed — do not reschedule
    // (that would loop on the same state forever).
    console.error(
      `[bottleimp] bot ${botId} stuck: ${action.kind} failed, fallback failed (${result.error})`,
    )
    return
  }
  onAfterMutation(room)
}
