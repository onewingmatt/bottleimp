// The Bottle Imp engine — pure functions, no side effects, no I/O.
// Deterministic given an injected RNG. All actions return new state (immutable).
//
// State machine: createGame → discard (each player discards 1 to Imp's Trick)
//   → exchange (pass 1 left + 1 right, simultaneous) → playing (tricks)
//   → hand_over (score) → restart → game_over.
import {
  DECK_SIZE,
  DEAL_COUNT,
  MIN_PLAYERS,
  MAX_PLAYERS,
  START_PRICE,
} from './constants'
import { buildDeck, shuffle, type RNG } from './deck'
import type {
  ActionResult,
  Card,
  GameState,
  PlayerSeed,
  PlayerState,
  TrickPlay,
  TrickState,
} from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function player(state: GameState, id: string): PlayerState {
  const p = state.players.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown player ${id}`)
  return p
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      hand: p.hand.slice(),
      tricksWon: p.tricksWon.map((t) => t.slice()),
    })),
    currentTrick: state.currentTrick
      ? { ...state.currentTrick, plays: state.currentTrick.plays.map((x) => ({ ...x })) }
      : null,
    impTrick: state.impTrick.slice(),
    history: state.history.slice(),
    incoming: Object.fromEntries(
      Object.entries(state.incoming).map(([k, v]) => [k, v.slice()]),
    ),
  }
}

function err(error: string): ActionResult {
  return { ok: false, error }
}

function isTrump(state: GameState, card: Card): boolean {
  return card.number < state.bottlePrice
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createGame(seeds: PlayerSeed[], rng: RNG): GameState {
  const count = seeds.length
  if (count < MIN_PLAYERS || count > MAX_PLAYERS) {
    throw new Error(`The Bottle Imp requires ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${count}`)
  }
  const deal = DEAL_COUNT[count]
  const deck = shuffle(buildDeck(), rng)
  const players: PlayerState[] = seeds.map((s) => ({
    id: s.id,
    name: s.name,
    hand: [],
    tricksWon: [],
    discarded: false,
    passedLeft: false,
    passedRight: false,
    disconnected: false,
    isBot: false,
  }))
  // Deal evenly, round-robin from the shuffled deck.
  const hands: Card[][] = Array.from({ length: count }, () => [])
  for (let i = 0; i < DECK_SIZE; i++) {
    hands[i % count].push(deck[i])
  }
  for (let i = 0; i < count; i++) {
    players[i].hand = hands[i]
    if (hands[i].length !== deal) {
      throw new Error(`Deal mismatch: expected ${deal} cards, got ${hands[i].length}`)
    }
  }
  const dealerId = players[Math.floor(rng() * count)].id
  const startIdx = players.findIndex((p) => p.id === dealerId)
  // First leader is the player left of the dealer.
  const leaderIndex = (startIdx + 1) % count
  const base: GameState = {
    players,
    playerOrder: seeds.map((s) => s.id),
    phase: 'discard',
    currentPlayerIndex: 0,
    currentTrick: null,
    bottlePrice: START_PRICE,
    bottleHolderId: null,
    impTrick: [],
    previousPrice: START_PRICE,
    history: [{ type: 'hand_start', dealerId, ts: Date.now() }],
    handNumber: 1,
    incoming: {},
  }
  return startDiscardPhase(base, leaderIndex)
}

// Discard phase: each player discards 1 card, clockwise from the leader.
function startDiscardPhase(state: GameState, leaderIndex: number): GameState {
  return { ...state, phase: 'discard', currentPlayerIndex: leaderIndex }
}

// Exchange phase: everyone simultaneously passes one card to each neighbor.
function startExchangePhase(state: GameState): ActionResult {
  return { ok: true, state: { ...state, phase: 'exchange' } }
}

// ---------------------------------------------------------------------------
// Discard phase
// ---------------------------------------------------------------------------

export function currentActorIndex(state: GameState): number {
  return state.currentPlayerIndex
}

export function currentActor(state: GameState): PlayerState | undefined {
  return state.players[state.currentPlayerIndex]
}

// Discard one card face-down to the Imp's Trick (hidden until scoring).
export function discardCard(state: GameState, playerId: string, cardId: string): ActionResult {
  const s = cloneState(state)
  if (s.phase !== 'discard') return err('Not in the discard phase')
  const p = player(s, playerId)
  if (s.playerOrder[s.currentPlayerIndex] !== playerId) return err('Not your turn to discard')
  const card = p.hand.find((c) => c.id === cardId)
  if (!card) return err('Card not in your hand')
  if (p.discarded) return err('Already discarded')
  p.hand = p.hand.filter((c) => c.id !== cardId)
  p.discarded = true
  s.impTrick = [...s.impTrick, card]
  s.history.push({ type: 'discard', playerId, ts: Date.now() })
  // Advance to next player who still needs to discard.
  const next = nextDiscarderIndex(s)
  if (next === null) {
    return startExchangePhase(s)
  }
  s.currentPlayerIndex = next
  return { ok: true, state: s }
}

function nextDiscarderIndex(s: GameState): number | null {
  const n = s.players.length
  for (let step = 1; step <= n; step++) {
    const idx = (s.currentPlayerIndex + step) % n
    if (!s.players[idx].discarded) return idx
  }
  return null
}

// ---------------------------------------------------------------------------
// Exchange phase
// ---------------------------------------------------------------------------

// Each player passes one card to their left neighbor and one to their right
// neighbor (simultaneous). Cards are committed face-down; when all have
// committed, the exchange resolves.
export function passCards(
  state: GameState,
  playerId: string,
  leftCardId: string,
  rightCardId: string,
): ActionResult {
  const s = cloneState(state)
  if (s.phase !== 'exchange') return err('Not in the exchange phase')
  const p = player(s, playerId)
  if (leftCardId === rightCardId) return err('Must pass two different cards')
  if (p.passedLeft || p.passedRight) return err('Already passed')
  const leftCard = p.hand.find((c) => c.id === leftCardId)
  const rightCard = p.hand.find((c) => c.id === rightCardId)
  if (!leftCard || !rightCard) return err('Card not in your hand')
  const n = s.players.length
  const myIdx = s.playerOrder.indexOf(playerId)
  const leftNeighbor = s.playerOrder[(myIdx + n - 1) % n] // left = previous in order
  const rightNeighbor = s.playerOrder[(myIdx + 1) % n] // right = next in order
  p.hand = p.hand.filter((c) => c.id !== leftCardId && c.id !== rightCardId)
  p.passedLeft = true
  p.passedRight = true
  // Stage incoming cards for neighbors (resolved once everyone committed).
  s.incoming[leftNeighbor] = [...(s.incoming[leftNeighbor] ?? []), leftCard]
  s.incoming[rightNeighbor] = [...(s.incoming[rightNeighbor] ?? []), rightCard]
  s.history.push({ type: 'exchange', playerId, ts: Date.now() })
  const allPassed = s.players.every((x) => x.passedLeft && x.passedRight)
  if (allPassed) {
    // Resolve: everyone takes their incoming cards.
    for (const pl of s.players) {
      const incoming = s.incoming[pl.id] ?? []
      pl.hand = [...pl.hand, ...incoming]
    }
    s.incoming = {}
    // Reset pass flags (not needed going forward but keeps state clean).
    for (const pl of s.players) {
      pl.passedLeft = false
      pl.passedRight = false
    }
    return startPlayingPhase(s)
  }
  return { ok: true, state: s }
}

function startPlayingPhase(s: GameState): ActionResult {
  // First leader is the player left of the dealer, already stored in
  // currentPlayerIndex from setup; reuse it for the first trick.
  const leaderIndex = s.currentPlayerIndex
  s.phase = 'playing'
  const price = s.bottlePrice
  s.currentTrick = {
    leaderId: s.playerOrder[leaderIndex],
    plays: [],
    price,
  }
  s.history.push({
    type: 'trick_start',
    leaderId: s.playerOrder[leaderIndex],
    price,
    ts: Date.now(),
  })
  return { ok: true, state: s }
}

// ---------------------------------------------------------------------------
// Playing phase (trick-taking)
// ---------------------------------------------------------------------------

export function currentTrickActor(state: GameState): PlayerState | undefined {
  if (state.phase !== 'playing' || !state.currentTrick) return undefined
  const n = state.players.length
  const leaderIdx = state.playerOrder.indexOf(state.currentTrick.leaderId)
  const playIdx = state.currentTrick.plays.length
  return state.players[(leaderIdx + playIdx) % n]
}

export function legalPlays(state: GameState, playerId: string): Card[] {
  if (state.phase !== 'playing' || !state.currentTrick) return []
  const p = player(state, playerId)
  const trick = state.currentTrick
  const leaderPlay = trick.plays[0]
  if (!leaderPlay) return p.hand.slice() // leader may play anything
  const ledSuit = leaderPlay.card.suit
  const canFollow = p.hand.filter((c) => c.suit === ledSuit)
  return (canFollow.length > 0 ? canFollow : p.hand.slice())
}

export function playCard(state: GameState, playerId: string, cardId: string): ActionResult {
  const s = cloneState(state)
  if (s.phase !== 'playing') return err('Not in the playing phase')
  const trick = s.currentTrick
  if (!trick) return err('No active trick')
  const actor = currentTrickActor(s)
  if (!actor || actor.id !== playerId) return err('Not your turn to play')
  const p = player(s, playerId)
  const card = p.hand.find((c) => c.id === cardId)
  if (!card) return err('Card not in your hand')
  const legal = legalPlays(s, playerId)
  if (!legal.some((c) => c.id === cardId)) {
    return err('Must follow suit if possible')
  }
  p.hand = p.hand.filter((c) => c.id !== cardId)
  trick.plays = [...trick.plays, { playerId, card }]
  s.history.push({ type: 'play', playerId, card, ts: Date.now() })
  // Trick complete?
  if (trick.plays.length < s.players.length) return { ok: true, state: s }
  return resolveTrick(s)
}

function resolveTrick(s: GameState): ActionResult {
  const trick = s.currentTrick!
  const price = trick.price
  const trumpPlays = trick.plays.filter((x) => x.card.number < price)
  let winner: TrickPlay
  if (trumpPlays.length > 0) {
    // Highest trump (closest to price, i.e. highest number below price) wins.
    winner = trumpPlays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
  } else {
    // No trump: highest number wins.
    winner = trick.plays.reduce((a, b) => (b.card.number > a.card.number ? b : a))
  }
  const winnerPlayer = player(s, winner.playerId)
  winnerPlayer.tricksWon = [...winnerPlayer.tricksWon, trick.plays.map((x) => x.card)]
  let bottleChanged = false
  let newPrice: number | null = null
  if (isTrump(s, winner.card)) {
    // Winner's card is below the current price → bottle transfers and the
    // price falls to the winning card's number.
    bottleChanged = true
    newPrice = winner.card.number
    // The previous price card goes to the bottle's former owner — but that
    // card is the former owner's own winning card from when they took the
    // bottle, so it is already in their won tricks. No extra card is needed.
    s.bottleHolderId = winner.playerId
    s.bottlePrice = winner.card.number
    s.previousPrice = winner.card.number
  }
  s.history.push({
    type: 'trick_end',
    winnerId: winner.playerId,
    winningCard: winner.card,
    bottleChanged,
    newPrice,
    ts: Date.now(),
  })
  s.currentTrick = null
  // Hand over when any player's hand is empty.
  if (s.players.some((p) => p.hand.length === 0)) {
    s.phase = 'hand_over'
    s.history.push({ type: 'hand_end', ts: Date.now() })
    return { ok: true, state: s }
  }
  // Next trick: winner leads.
  const winnerIdx = s.playerOrder.indexOf(winner.playerId)
  s.currentPlayerIndex = winnerIdx
  const priceNow = s.bottlePrice
  s.currentTrick = {
    leaderId: winner.playerId,
    plays: [],
    price: priceNow,
  }
  s.history.push({
    type: 'trick_start',
    leaderId: winner.playerId,
    price: priceNow,
    ts: Date.now(),
  })
  return { ok: true, state: s }
}
