// Bot AI — pure decision functions. Difficulty tiers:
//   easy:   random legal card
//   medium: follow suit, avoid winning with trumps, play lowest
//   hard:   coin-aware value model; wins worthwhile pots cheaply; leads from
//           strong suits; manages the bottle (dump it when stuck with it)
//   expert: Monte Carlo rollout of the current trick over hidden cards,
//           picking the play with the best expected coin/bottle outcome
// All decisions are legal-safe: the engine validates anyway, but bots check
// follow-suit before choosing. Bots use only PUBLIC information: their own
// hand, face-up tricks, the current trick, bottle state. They never peek at
// other players' hands.
import { START_PRICE, DEAL_COUNT } from './constants'
import { buildDeck, shuffle, type RNG } from './deck'
import { currentTrickActor, legalPlays } from './engine'
import type { Card, Difficulty, GameState, PlayerState, TrickState } from './types'

export type BotAction =
  | { kind: 'discard'; cardId: string }
  | { kind: 'pass'; leftCardId: string; rightCardId: string }
  | { kind: 'play'; cardId: string }

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

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

function sortByNumber(hand: Card[]): Card[] {
  return [...hand].sort((a, b) => a.number - b.number)
}

// Cards sorted by "dump order": weakest first. When we're losing a trick we
// want to throw away the card with the least future winning potential, and
// among equals prefer the one that feeds the winner the fewest coins.
function sortByDump(hand: Card[]): Card[] {
  return [...hand].sort((a, b) => a.number - b.number || a.coins - b.coins)
}

function trickPot(trick: TrickState): number {
  return trick.plays.reduce((sum, p) => sum + p.card.coins, 0)
}

// ---------------------------------------------------------------------------
// Discard decision
// ---------------------------------------------------------------------------

// Each player discards one card face-down to the Imp's Trick. Those coins are
// scored NEGATIVE by whoever holds the bottle at hand end — so a high-coin
// discard is poison for the eventual bottle holder, who is usually someone
// else. We discard our weakest card; among equally weak cards, prefer the
// highest coins to load the pile.
export function chooseDiscard(state: GameState, playerId: string, difficulty: Difficulty, rng: RNG): string {
  const hand = playerHand(state, playerId)
  if (hand.length === 0) throw new Error('No cards to discard')
  if (difficulty === 'easy') return pick(hand, rng).id

  const sorted = sortByNumber(hand)
  if (difficulty === 'medium') return sorted[0].id
  // hard/expert: weakest number first, tie-break by highest coins (poison).
  const weakestNum = sorted[0].number
  const candidates = sorted.filter((c) => c.number === weakestNum)
  candidates.sort((a, b) => b.coins - a.coins)
  return candidates[0].id
}

// ---------------------------------------------------------------------------
// Exchange decision
// ---------------------------------------------------------------------------

// Pass our weakest cards to neighbors. Strategy: keep high cards and trumps,
// dump low cards, and try to void a suit (pass two of the same suit) so we can
// play anything when that suit is led later.
function exchangeValue(card: Card): number {
  // High coins are worth keeping (they score when we win), high numbers win
  // tricks. Low value = good to give away.
  return card.number + card.coins * 3
}

export function chooseExchange(
  state: GameState,
  playerId: string,
  difficulty: Difficulty,
  rng: RNG,
): { left: string; right: string } {
  const hand = playerHand(state, playerId)
  if (difficulty === 'easy') {
    const [a, b] = shuffle(hand, rng)
    return { left: a.id, right: b.id }
  }
  const ranked = [...hand].sort((a, b) => exchangeValue(a) - exchangeValue(b))
  if (difficulty === 'medium') {
    return { left: ranked[0].id, right: ranked[1].id }
  }
  // hard/expert: among the bottom 4 by value, prefer the cheapest same-suit
  // pair (voiding a suit is good, but not with our best cards).
  const bottom = ranked.slice(0, 4)
  let bestPair: Card[] | null = null
  for (const suit of ['red', 'blue', 'yellow'] as const) {
    const pair = bottom.filter((c) => c.suit === suit)
    if (pair.length >= 2) {
      const pairValue = exchangeValue(pair[0]) + exchangeValue(pair[1])
      if (!bestPair || pairValue < exchangeValue(bestPair[0]) + exchangeValue(bestPair[1])) {
        bestPair = pair
      }
    }
  }
  if (bestPair) {
    return { left: bestPair[0].id, right: bestPair[1].id }
  }
  return { left: ranked[0].id, right: ranked[1].id }
}

// ---------------------------------------------------------------------------
// Trick play decision
// ---------------------------------------------------------------------------

// Winning-card check under Bottle Imp resolution:
// - If ANY trump was played, the highest trump wins.
// - Otherwise the highest number wins.
function winsTrick(trick: TrickState, myCard: Card): boolean {
  const plays = [...trick.plays, { card: myCard } as { card: Card }]
  const trumpPlays = plays.filter((x) => x.card.number < trick.price)
  if (trumpPlays.length > 0) {
    const best = trumpPlays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
    return best.card.id === myCard.id
  }
  const best = plays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
  return best.card.id === myCard.id
}

// Cards that beat the current best under trump rules — i.e. cards that would
// win the trick if played now.
function winningCards(state: GameState, legal: Card[]): Card[] {
  const trick = state.currentTrick
  if (!trick || trick.plays.length === 0) return legal // leader wins any trick
  return legal.filter((c) => winsTrick(trick, c))
}

// Estimate the value of winning a trick with a specific card. Winning with a
// trump transfers (or keeps) the bottle, which is usually bad.
function winValue(state: GameState, card: Card, pot: number, iHoldBottle: boolean): number {
  const isTrumpWin = isTrump(state, card)
  if (iHoldBottle) {
    // Our trick coins are ignored at scoring. Winning with a trump while
    // holding is the worst possible outcome: the bottle stays with us AND the
    // price drops, killing the trumps we need to dump it. Winning a non-trump
    // trick is neutral-ish (bottle stays but price survives, and we gain the
    // lead to try a dump).
    return isTrumpWin ? -30 : 0
  }
  if (isTrumpWin) {
    // We would take the bottle. Only worth it for a very fat pot... and even
    // then it's usually a trap. Let the caller decide via a big penalty.
    return pot - BOTTLE_PENALTY
  }
  return pot
}

const BOTTLE_PENALTY = 30 // taking the bottle now risks holding it to the end — worth our whole trick score + the imp pile
const BOTTLE_RELIEF = 40 // someone else winning a trump trick takes the bottle off us — worth our whole trick score + the imp pile
const WIN_POT_THRESHOLD = 9 // minimum coins on the table to bother winning a trick

function choosePlayHard(state: GameState, playerId: string): string {
  const legal = legalPlays(state, playerId)
  if (legal.length === 0) throw new Error('No legal plays')
  const me = state.players.find((x) => x.id === playerId)!
  const iHoldBottle = me.id === state.bottleHolderId
  const trick = state.currentTrick
  const leading = !trick || trick.plays.length === 0

  // Holding the bottle: never win. We want someone else to win a trump trick
  // so they take the bottle. Play our lowest-dump card (fewest coins fed).
  if (iHoldBottle) {
    if (leading) return sortByDump(legal)[0].id
    return sortByDump(legal)[0].id
  }

  if (leading) {
    // Lead from our strongest suit with a NON-trump card when possible:
    // that wins coin tricks without risking the bottle. Prefer the highest
    // non-trump; if forced to lead a trump, lead the lowest one.
    const nonTrump = legal.filter((c) => !isTrump(state, c))
    if (nonTrump.length > 0) {
      // Prefer the suit where we hold the single highest card: sort by number
      // descending, then by the strength of that suit's top card.
      const bySuit = new Map<string, Card[]>()
      for (const c of nonTrump) {
        if (!bySuit.has(c.suit)) bySuit.set(c.suit, [])
        bySuit.get(c.suit)!.push(c)
      }
      let best: Card | null = null
      for (const suitCards of bySuit.values()) {
        const top = [...suitCards].sort((a, b) => b.number - a.number)[0]
        if (!best || top.number > best.number) best = top
      }
      return best!.id
    }
    return sortByNumber(legal)[0].id // must lead a trump: lead the weakest
  }

  // Following. No bottle (handled above).
  const pot = trickPot(trick!)
  const trumpPlayed = trick!.plays.some((x) => isTrump(state, x.card))

  if (trumpPlayed) {
    // We can only win by playing a higher trump, which would take the bottle.
    // Dump our weakest card instead.
    return sortByDump(legal)[0].id
  }

  // No trump out yet. Can we win with a non-trump and is the pot worth it?
  const winners = winningCards(state, legal).filter((c) => !isTrump(state, c))
  if (winners.length > 0) {
    const cheapest = [...winners].sort((a, b) => a.number - b.number)[0]
    const totalPot = pot + cheapest.coins
    if (totalPot >= WIN_POT_THRESHOLD && cheapest.number <= totalPot * 2 + 4) {
      return cheapest.id
    }
  }
  return sortByDump(legal)[0].id
}

// ---------------------------------------------------------------------------
// Expert: Monte Carlo rollout of the current trick
// ---------------------------------------------------------------------------

const ROLLOUTS = 48

// The unseen card pool from public info: everything not in our hand, not in
// any face-up won trick, not in the current trick, not in the face-down
// Imp's Trick. Opponents' hands are sampled from here.
function unseenPool(state: GameState, playerId: string): Card[] {
  const known = new Set<string>()
  for (const c of playerHand(state, playerId)) known.add(c.id)
  for (const p of state.players) {
    for (const trick of p.tricksWon) for (const c of trick) known.add(c.id)
  }
  for (const play of state.currentTrick?.plays ?? []) known.add(play.card.id)
  for (const c of state.impTrick) known.add(c.id)
  return buildDeck().filter((c) => !known.has(c.id))
}

function remainingHandSize(state: GameState, playerId: string): number {
  // Completed tricks = sum over players of tricks they won (each completed
  // trick is in exactly one player's tricksWon). Every player has played one
  // card per completed trick; discard removed one card; exchange nets zero.
  const completed = state.players.reduce((sum, p) => sum + p.tricksWon.length, 0)
  return DEAL_COUNT[state.players.length] - 1 - completed
}

// Simple opponent policy for rollouts: follow suit; if they don't hold the
// bottle, win cheap non-trump tricks that are worth it; otherwise dump low.
function opponentPlay(state: GameState, oppId: string, hand: Card[], trick: TrickState): Card {
  const legal = legalPlaysFromHand(state, oppId, hand, trick)
  if (legal.length === 0) return hand[0]
  const opp = state.players.find((x) => x.id === oppId)!
  const holdsBottle = opp.id === state.bottleHolderId
  if (holdsBottle) return sortByDump(legal)[0]
  const trumpPlayed = trick.plays.some((x) => x.card.number < trick.price)
  if (trumpPlayed) return sortByDump(legal)[0]
  const winners = legal.filter((c) => !(c.number < trick.price) && winsTrick(trick, c))
  if (winners.length > 0) {
    const cheapest = [...winners].sort((a, b) => a.number - b.number)[0]
    const pot = trickPot(trick) + cheapest.coins
    if (pot >= WIN_POT_THRESHOLD && cheapest.number <= pot * 2 + 4) {
      return cheapest
    }
  }
  return sortByDump(legal)[0]
}

function legalPlaysFromHand(state: GameState, playerId: string, hand: Card[], trick: TrickState): Card[] {
  if (trick.plays.length === 0) return hand.slice()
  const ledSuit = trick.plays[0].card.suit
  const canFollow = hand.filter((c) => c.suit === ledSuit)
  return canFollow.length > 0 ? canFollow : hand.slice()
}

// Resolve a trick from the plays list; returns winner id and whether the
// winning card was a trump.
function resolveSim(trick: TrickState): { winnerId: string; trumpWin: boolean } {
  const trumpPlays = trick.plays.filter((x) => x.card.number < trick.price)
  let winner = trick.plays[0]
  if (trumpPlays.length > 0) {
    winner = trumpPlays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
    return { winnerId: winner.playerId, trumpWin: true }
  }
  winner = trick.plays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
  return { winnerId: winner.playerId, trumpWin: false }
}

function choosePlayExpert(state: GameState, playerId: string, rng: RNG): string {
  const legal = legalPlays(state, playerId)
  if (legal.length <= 1) return legal[0].id
  const trick = state.currentTrick!
  const me = state.players.find((x) => x.id === playerId)!
  const iHoldBottle = me.id === state.bottleHolderId

  // Remaining actors after us in this trick, in play order.
  const n = state.players.length
  const leaderIdx = state.playerOrder.indexOf(trick.leaderId)
  const myPlayIdx = trick.plays.length
  const remaining: string[] = []
  for (let i = 1; i < n - myPlayIdx; i++) {
    remaining.push(state.playerOrder[(leaderIdx + myPlayIdx + i) % n])
  }

  const pool = unseenPool(state, playerId)
  const handSize = remainingHandSize(state, playerId)
  const scores = new Map<string, number>()

  for (const candidate of legal) {
    let total = 0
    for (let r = 0; r < ROLLOUTS; r++) {
      const simTrick: TrickState = {
        leaderId: trick.leaderId,
        price: trick.price,
        plays: trick.plays.map((x) => ({ ...x })),
      }
      simTrick.plays.push({ playerId, card: candidate })
      const simHands = new Map<string, Card[]>()
      const poolCopy = shuffle(pool, rng)
      let idx = 0
      for (const oppId of remaining) {
        const hand = poolCopy.slice(idx, idx + handSize)
        idx += handSize
        simHands.set(oppId, hand)
      }
      for (const oppId of remaining) {
        const card = opponentPlay(state, oppId, simHands.get(oppId)!, simTrick)
        simTrick.plays.push({ playerId: oppId, card })
      }
      const { winnerId, trumpWin } = resolveSim(simTrick)
      const pot = simTrick.plays.reduce((s, x) => s + x.card.coins, 0)
      if (winnerId === playerId) {
        total += winValue(state, candidate, pot, iHoldBottle)
      } else if (iHoldBottle) {
        // Holding the bottle: our own trick coins are ignored at scoring, so
        // the only thing that matters is whether someone won with a trump and
        // took the bottle off us. Feeding coins is irrelevant to our score.
        if (trumpWin) total += BOTTLE_RELIEF
      } else {
        // Not holding: the winner takes our card's coins.
        total -= candidate.coins
      }
    }
    scores.set(candidate.id, total / ROLLOUTS)
  }

  // Best EV; tie-break by lowest number (don't waste high cards).
  const best = [...scores.entries()].sort((a, b) => {
    const ev = b[1] - a[1]
    if (ev !== 0) return ev
    const ca = legal.find((c) => c.id === a[0])!
    const cb = legal.find((c) => c.id === b[0])!
    return ca.number - cb.number
  })[0]
  return best[0]
}

export function choosePlay(state: GameState, playerId: string, difficulty: Difficulty, rng: RNG): string {
  const legal = legalPlays(state, playerId)
  if (legal.length === 0) throw new Error('No legal plays')
  if (difficulty === 'easy') return pick(legal, rng).id
  if (difficulty === 'expert') return choosePlayExpert(state, playerId, rng)
  if (difficulty === 'medium') return choosePlayMedium(state, playerId)
  return choosePlayHard(state, playerId)
}

// Medium: a simple, readable baseline. Follow suit, play the LOWEST card,
// and prefer non-trumps (avoid accidentally taking the bottle).
function choosePlayMedium(state: GameState, playerId: string): string {
  const legal = legalPlays(state, playerId)
  const safe = legal.filter((c) => !isTrump(state, c))
  const pool = safe.length > 0 ? safe : legal
  return sortByNumber(pool)[0].id
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
    return { kind: 'discard', cardId: chooseDiscard(state, playerId, difficulty, rng) }
  }
  if (state.phase === 'exchange') {
    const { left, right } = chooseExchange(state, playerId, difficulty, rng)
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
