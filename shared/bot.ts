// Bot AI — pure decision functions. Difficulty tiers:
//   easy:   random legal card
//   medium: follow suit, avoid winning with trumps / avoid taking the bottle
//   hard:   value the trick, avoid/dump the bottle, deny opponents
// All decisions are legal-safe: the engine validates anyway, but bots check
// follow-suit before choosing.
import { START_PRICE } from './constants'
import type { RNG } from './deck'
import { currentTrickActor, legalPlays } from './engine'
import type { Card, Difficulty, GameState } from './types'

export type BotAction =
  | { kind: 'discard'; cardId: string }
  | { kind: 'pass'; leftCardId: string; rightCardId: string }
  | { kind: 'play'; cardId: string }

function playerHand(state: GameState, playerId: string): Card[] {
  const p = state.players.find((x) => x.id === playerId)
  return p ? p.hand : []
}

function isTrump(state: GameState, card: Card): boolean {
  return card.number < state.bottlePrice
}

// Random element helper — pure given rng.
function pick<T>(arr: T[], rng: RNG): T {
  return arr[Math.floor(rng() * arr.length)]
}

// Score a card for "badness" of taking the bottle with it: trumps are
// dangerous because winning with a trump transfers the bottle to you.
function cardRisk(state: GameState, card: Card): number {
  if (!isTrump(state, card)) return 0
  // Closer to the price = more likely to be the highest trump played and win.
  return state.bottlePrice - card.number
}

// ---------------------------------------------------------------------------
// Discard decision
// ---------------------------------------------------------------------------

// Discard the card we least want: the lowest-value card, preferring to keep
// high cards and to void a suit. Simple heuristic: discard the card with the
// lowest number (lowest trick strength); tie-break by coins.
export function chooseDiscard(state: GameState, playerId: string, rng: RNG): string {
  const hand = playerHand(state, playerId)
  if (hand.length === 0) throw new Error('No cards to discard')
  // Discard the lowest-number card (weakest). Random among equals.
  const minNum = Math.min(...hand.map((c) => c.number))
  const candidates = hand.filter((c) => c.number === minNum)
  return pick(candidates, rng).id
}

// ---------------------------------------------------------------------------
// Exchange decision
// ---------------------------------------------------------------------------

// Pass our weakest card to a neighbor. Strategy: pass low cards away, keep
// high cards and trumps we might use. Pass the lowest-number card left and
// the next-lowest right.
export function chooseExchange(state: GameState, playerId: string, rng: RNG): { left: string; right: string } {
  const hand = playerHand(state, playerId)
  const sorted = [...hand].sort((a, b) => a.number - b.number)
  const left = sorted[0]
  const right = sorted[1] ?? sorted[0]
  return { left: left.id, right: right.id }
}

// ---------------------------------------------------------------------------
// Trick play decision
// ---------------------------------------------------------------------------

export function choosePlay(state: GameState, playerId: string, difficulty: Difficulty, rng: RNG): string {
  const legal = legalPlays(state, playerId)
  if (legal.length === 0) throw new Error('No legal plays')
  if (difficulty === 'easy') {
    return pick(legal, rng).id
  }

  const trick = state.currentTrick
  const isLeader = !trick || trick.plays.length === 0
  const leading = isLeader

  if (difficulty === 'medium') {
    // Follow suit, but prefer to avoid taking the bottle:
    // - If we can play a non-trump (or a high non-dangerous card), do that.
    // - Avoid winning with a trump if possible.
    const safe = legal.filter((c) => !isTrump(state, c) || c.number < state.bottlePrice - 2)
    const pool = safe.length > 0 ? safe : legal
    // Prefer to dump the lowest card unless we're holding the bottle and
    // want to avoid taking more.
    return pool.sort((a, b) => a.number - b.number)[0]?.id ?? pick(legal, rng).id
  }

  // hard: more deliberate.
  const me = state.players.find((x) => x.id === playerId)
  const iHoldBottle = me?.id === state.bottleHolderId
  const isTrumpPlayed = trick?.plays.some((x) => isTrump(state, x.card)) ?? false
  // If a trump is already played, we cannot win with a non-trump unless we
  // play a higher trump. Usually best to dump the weakest card that doesn't
  // accidentally take the bottle — unless we hold the bottle and must avoid
  // keeping it.
  if (leading) {
    // Leading: avoid leading a trump (would invite the bottle onto us).
    const nonTrump = legal.filter((c) => !isTrump(state, c))
    if (nonTrump.length > 0) return nonTrump.sort((a, b) => a.number - b.number)[0].id
    // Must lead a trump: lead the weakest (lowest) trump to minimize risk.
    return legal.sort((a, b) => a.number - b.number)[0].id
  }
  if (isTrumpPlayed) {
    // A trump is out — playing any trump could win (bad, bottle) unless we
    // hold the bottle and want to pass it on. If we hold the bottle, we want
    // to win with the bottle transfer to dump it on someone else... but the
    // rule transfers the bottle to the winner of a trump. Actually the bottle
    // goes to the winner of the trick when the winning card is a trump, so if
    // we hold the bottle, winning a trump trick does NOT free us (we keep it).
    // The only way to dump is to have someone else win a trump trick.
    // Strategy: if we hold the bottle, play the lowest card (avoid winning);
    // if not, play the lowest card too (avoid taking the bottle).
    return legal.sort((a, b) => a.number - b.number)[0].id
  }
  // No trump played yet. We may want to win this trick (take coins) but only
  // with a NON-trump so we don't take the bottle. If we can play a card that
  // is the current highest non-trump, do it; else dump lowest.
  const winningCard = trick?.plays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
  const canWinWithoutTrump = legal.some((c) => !isTrump(state, c) && (!winningCard || c.number > winningCard.card.number))
  if (canWinWithoutTrump) {
    const winners = legal
      .filter((c) => !isTrump(state, c) && (!winningCard || c.number > winningCard.card.number))
      .sort((a, b) => a.number - b.number)
    // Prefer a modest winning card (don't waste a high card if a low one wins).
    if (iHoldBottle) {
      // Holding the bottle: winning a NON-trump trick is fine (bottle stays),
      // but prefer the cheapest winning card.
      return winners[0].id
    }
    // Not holding: take the trick cheaply.
    return winners[0].id
  }
  // Can't win without trump: dump the lowest.
  return legal.sort((a, b) => a.number - b.number)[0].id
}

// ---------------------------------------------------------------------------
// Dispatch — what should this bot do right now?
// ---------------------------------------------------------------------------

export function botAction(
  state: GameState,
  playerId: string,
  difficulty: Difficulty,
  rng: RNG,
): BotAction {
  if (state.phase === 'discard') {
    return { kind: 'discard', cardId: chooseDiscard(state, playerId, rng) }
  }
  if (state.phase === 'exchange') {
    const { left, right } = chooseExchange(state, playerId, rng)
    return { kind: 'pass', leftCardId: left, rightCardId: right }
  }
  if (state.phase === 'playing') {
    const actor = currentTrickActor(state)
    if (actor?.id === playerId) {
      return { kind: 'play', cardId: choosePlay(state, playerId, difficulty, rng) }
    }
  }
  throw new Error(`botAction called for ${playerId} but it is not their turn (phase=${state.phase})`)
}

// Highest-level check the scheduler uses before scheduling a bot.
export function isBotsTurn(state: GameState, playerId: string): boolean {
  if (state.phase === 'discard') return state.playerOrder[state.currentPlayerIndex] === playerId
  if (state.phase === 'exchange') return state.players.some((p) => p.id === playerId && !(p.passedLeft && p.passedRight))
  if (state.phase === 'playing') return currentTrickActor(state)?.id === playerId
  return false
}

// Exported for tests/balance: the start price (19) is the initial bottle price.
export const BOTTLE_START_PRICE = START_PRICE
