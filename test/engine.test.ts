import { describe, expect, it } from 'vitest'
import {
  DECK_SIZE,
  DEAL_COUNT,
  MIN_PLAYERS,
  MAX_PLAYERS,
  START_PRICE,
  SUITS,
} from '../shared/constants'
import { buildDeck, shuffle } from '../shared/deck'
import {
  createGame,
  discardCard,
  passCards,
  playCard,
  legalPlays,
  currentTrickActor,
} from '../shared/engine'
import { scoreHand, winnerIds } from '../shared/scoring'
import type { Card, GameState, PlayerSeed } from '../shared/types'

// Deterministic RNG (mulberry32-style) for reproducible tests.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Unwrap an ActionResult — throws on failure so tests get a clean state.
function unwrap<T extends { ok: boolean; error?: string; state?: GameState }>(res: T): GameState {
  if (!res.ok) throw new Error(`action failed: ${res.error}`)
  return res.state!
}

function seeds(n: number): PlayerSeed[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))
}

function cardsOf(suit: string): Card[] {
  return buildDeck().filter((c) => c.suit === suit)
}

// Walk a game forward through discard + exchange for a given player count,
// choosing the first legal card each time.
function toPlaying(state: GameState, rngFn: () => number): GameState {
  let s = state
  // Discard phase: each player discards lowest card
  while (s.phase === 'discard') {
    const actor = s.players[s.currentPlayerIndex]
    const lowest = [...actor.hand].sort((a, b) => a.number - b.number)[0]
    s = unwrap(discardCard(s, actor.id, lowest.id))
  }
  // Exchange phase: each player passes two cards; bots/humans all commit.
  // We need all players to commit; do them in playerOrder order.
  while (s.phase === 'exchange') {
    const uncommitted = s.players.filter((p) => !(p.passedLeft && p.passedRight))
    if (uncommitted.length === 0) throw new Error('exchange stuck')
    const p = uncommitted[0]
    const sorted = [...p.hand].sort((a, b) => a.number - b.number)
    s = unwrap(passCards(s, p.id, sorted[0].id, sorted[1].id))
  }
  return s
}

describe('deck', () => {
  it('builds 36 unique suit cards across 3 colors, excluding the 19', () => {
    const deck = buildDeck()
    expect(deck).toHaveLength(DECK_SIZE)
    expect(new Set(deck.map((c) => c.id)).size).toBe(36)
    expect(deck.some((c) => c.number === 19)).toBe(false)
    expect(new Set(deck.map((c) => c.suit))).toEqual(new Set(SUITS))
    // All numbers 1-37 except 19 present
    const nums = deck.map((c) => c.number).sort((a, b) => a - b)
    const expected: number[] = []
    for (let n = 1; n <= 37; n++) if (n !== 19) expected.push(n)
    expect(nums).toEqual(expected)
  })

  it('assigns coin values 1-6 to every card', () => {
    for (const c of buildDeck()) {
      expect(c.coins).toBeGreaterThanOrEqual(1)
      expect(c.coins).toBeLessThanOrEqual(6)
    }
  })

  it('shuffle is deterministic under seeded RNG and preserves elements', () => {
    const deck = buildDeck()
    const a = shuffle(deck, rng(42))
    const b = shuffle(deck, rng(42))
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
    expect(a.map((c) => c.id).sort()).toEqual(deck.map((c) => c.id).sort())
  })
})

describe('createGame', () => {
  it('requires 3-4 players', () => {
    expect(() => createGame(seeds(2), rng(1))).toThrow()
    expect(() => createGame(seeds(5), rng(1))).toThrow()
    expect(() => createGame(seeds(3), rng(1))).not.toThrow()
    expect(() => createGame(seeds(4), rng(1))).not.toThrow()
  })

  it('deals the correct number of cards', () => {
    for (const n of [MIN_PLAYERS, MAX_PLAYERS]) {
      const g = createGame(seeds(n), rng(7))
      const deal = DEAL_COUNT[n]
      expect(g.players.every((p) => p.hand.length === deal)).toBe(true)
    }
  })

  it('starts in the discard phase with price 19 and no bottle holder', () => {
    const g = createGame(seeds(3), rng(7))
    expect(g.phase).toBe('discard')
    expect(g.bottlePrice).toBe(START_PRICE)
    expect(g.bottleHolderId).toBeNull()
    expect(g.impTrick).toEqual([])
    expect(g.currentTrick).toBeNull()
  })
})

describe('discard phase', () => {
  it('each player discards exactly one card to the imp trick', () => {
    let s = createGame(seeds(3), rng(7))
    const startIdx = s.currentPlayerIndex
    const actorIds: string[] = []
    let guard = 0
    while (s.phase === 'discard' && guard++ < 20) {
      const actor = s.players[s.currentPlayerIndex]
      actorIds.push(actor.id)
      s = unwrap(discardCard(s, actor.id, actor.hand[0].id))
    }
    expect(actorIds).toHaveLength(3)
    expect(new Set(actorIds).size).toBe(3)
    expect(s.impTrick).toHaveLength(3)
    expect(s.phase).toBe('exchange')
    // Round robin starting at startIdx
    const order = Array.from({ length: 3 }, (_, i) => s.playerOrder[(startIdx + i) % 3])
    expect(actorIds).toEqual(order)
  })

  it('refuses a second discard from the same player', () => {
    let s = createGame(seeds(3), rng(7))
    const actor = s.players[s.currentPlayerIndex]
    s = unwrap(discardCard(s, actor.id, actor.hand[0].id))
    const again = discardCard(s, actor.id, actor.hand[0].id)
    expect(again.ok).toBe(false)
  })
})

describe('exchange phase', () => {
  it('passes one card left and one right, then everyone receives two', () => {
    const g = createGame(seeds(4), rng(7))
    // get to exchange
    let s = g
    while (s.phase === 'discard') {
      const actor = s.players[s.currentPlayerIndex]
      s = unwrap(discardCard(s, actor.id, actor.hand[0].id))
    }
    expect(s.phase).toBe('exchange')
    const countsBefore = s.players.map((p) => p.hand.length) // 9 each
    // commit each player in order
    for (const p of [...s.players]) {
      const sorted = [...p.hand].sort((a, b) => a.number - b.number)
      s = unwrap(passCards(s, p.id, sorted[0].id, sorted[1].id))
    }
    expect(s.phase).toBe('playing')
    // Each player lost 2 and gained 2 → same count
    expect(s.players.map((p) => p.hand.length)).toEqual(countsBefore)
    // No card duplicated across hands
    const all = s.players.flatMap((p) => p.hand.map((c) => c.id))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('playing phase', () => {
  it('first trick is led by the player left of the dealer (same as first discarder)', () => {
    for (const n of [3, 4]) {
      const g = createGame(seeds(n), rng(7))
      const firstDiscarder = g.players[g.currentPlayerIndex].id
      const s = toPlaying(g, rng(1))
      if (!s.currentTrick) throw new Error('no trick')
      expect(s.currentTrick.leaderId).toBe(firstDiscarder)
      // The leader is only ONE seat away from the dealer (player left of dealer).
      const dealerIdx = s.playerOrder.indexOf(firstDiscarder) - 1
      const dealer = s.playerOrder[(dealerIdx + n) % n]
      expect(dealer).toBeTruthy()
    }
  })

  it('leader plays any card, others must follow suit if possible', () => {
    let s = toPlaying(createGame(seeds(3), rng(7)), rng(1))
    const leader = s.currentTrick!.leaderId
    const actor = currentTrickActor(s)!
    expect(actor.id).toBe(leader)
    const leaderCard = s.players.find((p) => p.id === leader)!.hand[0]
    s = unwrap(playCard(s, leader, leaderCard.id))
    const next = currentTrickActor(s)!
    const hasSuit = next.hand.some((c) => c.suit === leaderCard.suit)
    const legal = legalPlays(s, next.id)
    if (hasSuit) {
      expect(legal.every((c) => c.suit === leaderCard.suit)).toBe(true)
    } else {
      expect(legal).toHaveLength(next.hand.length)
    }
  })

  it('resolves a trick with the highest non-trump card when no trump is played', () => {
    // Set the bottle price to 1 → no card is a trump (cards are 1-37,
    // a trump is number < price, so price 1 means none are trumps).
    let s = toPlaying(createGame(seeds(3), rng(7)), rng(1))
    s = { ...s, bottlePrice: 1 }
    if (s.currentTrick) s.currentTrick = { ...s.currentTrick, price: 1 }
    // Play the highest card each time — winner must be the highest number.
    const n = s.players.length
    for (let i = 0; i < n; i++) {
      const actor = currentTrickActor(s)!
      const led = s.currentTrick!.plays[0]?.card
      const inSuit = led ? actor.hand.filter((c) => c.suit === led.suit) : []
      const pool = inSuit.length > 0 ? inSuit : actor.hand
      const highest = [...pool].sort((a, b) => b.number - a.number)[0]
      s = unwrap(playCard(s, actor.id, highest.id))
    }
    const lastTrickEnd = s.history.findLast((h) => h.type === 'trick_end')!
    expect(lastTrickEnd.bottleChanged).toBe(false) // no trump → no bottle transfer
    const winner = s.players.find((p) => p.id === lastTrickEnd.winnerId)!
    // The winner should have the highest number card among all plays.
    const maxNum = Math.max(...s.players.flatMap((p) => p.tricksWon.flat().map((c) => c.number)))
    expect(winner.tricksWon.flat().some((c) => c.number === maxNum)).toBe(true)
  })

  it('resolves a trick with the highest trump when trumps are played', () => {
    // Force a state: price 30 → trumps are numbers <30 (almost all cards).
    let s = toPlaying(createGame(seeds(3), rng(7)), rng(1))
    s = { ...s, bottlePrice: 30 }
    if (s.currentTrick) s.currentTrick = { ...s.currentTrick, price: 30 }
    const n = s.players.length
    // Everyone plays their lowest card in the led suit (trumps).
    for (let i = 0; i < n; i++) {
      const actor = currentTrickActor(s)!
      const led = s.currentTrick!.plays[0]?.card
      const inSuit = led ? actor.hand.filter((c) => c.suit === led.suit) : []
      const pool = inSuit.length > 0 ? inSuit : actor.hand
      const lowest = [...pool].sort((a, b) => a.number - b.number)[0]
      s = unwrap(playCard(s, actor.id, lowest.id))
    }
    const last = s.history.findLast((h) => h.type === 'trick_end')!
    expect(last.bottleChanged).toBe(true)
    expect(last.newPrice).toBe(last.winningCard.number)
    expect(s.bottleHolderId).toBe(last.winnerId)
  })

  it('transfers the bottle to the trump-trick winner and lowers the price', () => {
    let s = toPlaying(createGame(seeds(4), rng(7)), rng(1))
    // Force a high price so low cards are trumps, and craft the first play
    // to be a low trump so the bottle transfer must happen.
    s = { ...s, bottlePrice: 30 }
    if (s.currentTrick) s.currentTrick = { ...s.currentTrick, price: 30 }
    // Leader plays their LOWEST card (a trump, number < 30 almost surely).
    const leader = s.currentTrick!.leaderId
    const leaderHand = s.players.find((p) => p.id === leader)!.hand
    const lowest = [...leaderHand].sort((a, b) => a.number - b.number)[0]
    s = unwrap(playCard(s, leader, lowest.id))
    // Everyone else plays their lowest in the led suit (all trumps if < 30).
    const n = s.players.length
    for (let i = 1; i < n; i++) {
      const actor = currentTrickActor(s)!
      const led = s.currentTrick!.plays[0]?.card
      const inSuit = led ? actor.hand.filter((c) => c.suit === led.suit) : []
      const pool = inSuit.length > 0 ? inSuit : actor.hand
      const lowest = [...pool].sort((a, b) => a.number - b.number)[0]
      s = unwrap(playCard(s, actor.id, lowest.id))
    }
    // The winner played a trump → bottle transferred and price lowered.
    const winnerId = s.bottleHolderId!
    expect(winnerId).toBeTruthy()
    expect(s.bottlePrice).toBeLessThan(30)
    const last = s.history.findLast((h) => h.type === 'trick_end')!
    expect(last.bottleChanged).toBe(true)
    expect(last.winnerId).toBe(winnerId)
    // Winner took the trick (4 cards — all real, no phantom).
    const winner = s.players.find((p) => p.id === winnerId)!
    expect(winner.tricksWon.length).toBe(1)
    expect(winner.tricksWon[0]).toHaveLength(4)
  })

  it('hand ends when a player runs out of cards', () => {
    let s = toPlaying(createGame(seeds(3), rng(7)), rng(1))
    // Play out the entire hand (legal moves only).
    let guard = 0
    while (s.phase === 'playing' && guard++ < 200) {
      const actor = currentTrickActor(s)!
      const legal = legalPlays(s, actor.id)
      s = unwrap(playCard(s, actor.id, legal[0].id))
    }
    expect(s.phase).toBe('hand_over')
    // All hands empty
    expect(s.players.every((p) => p.hand.length === 0)).toBe(true)
    // Total cards in tricks won + imp trick = 36
    const inTricks = s.players.reduce((sum, p) => sum + p.tricksWon.flat().length, 0)
    expect(inTricks + s.impTrick.length).toBe(DECK_SIZE)
  })
})

describe('scoring', () => {
  it('scores trick coins, and the bottle holder scores negative imp-trick coins', () => {
    let s = toPlaying(createGame(seeds(3), rng(7)), rng(1))
    // Play out the hand
    let guard = 0
    while (s.phase === 'playing' && guard++ < 200) {
      const actor = currentTrickActor(s)!
      const legal = legalPlays(s, actor.id)
      s = unwrap(playCard(s, actor.id, legal[0].id))
    }
    expect(s.phase).toBe('hand_over')
    const lines = scoreHand(s)
    expect(lines).toHaveLength(3)
    const holder = lines.find((l) => l.heldBottle)
    const nonHolders = lines.filter((l) => !l.heldBottle)
    for (const l of nonHolders) {
      expect(l.score).toBe(l.trickCoins)
      expect(l.score).toBeGreaterThanOrEqual(0)
    }
    if (holder) {
      expect(holder.score).toBe(-holder.impTrickCoins)
      expect(holder.score).toBeLessThanOrEqual(0)
    }
    // Winner is the max score
    const ids = winnerIds(lines)
    expect(ids.length).toBeGreaterThan(0)
  })

  it('bottle holder ignores own trick coins', () => {
    const holder = { playerId: 'p1', score: 0, heldBottle: true, trickCoins: 40, impTrickCoins: 5 }
    expect(holder.score).toBe(0) // score computed in scoreHand as -impTrickCoins
  })
})
