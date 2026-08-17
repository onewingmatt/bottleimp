import { describe, expect, it } from 'vitest'
import { DEAL_COUNT } from '../shared/constants'
import { createGame, discardCard, passCards, playCard, legalPlays, currentTrickActor } from '../shared/engine'
import { scoreHand } from '../shared/scoring'
import {
  botAction,
  chooseDiscard,
  chooseExchange,
  choosePlay,
  isBotsTurn,
} from '../shared/bot'
import type { Card, Difficulty, GameState, PlayerSeed } from '../shared/types'

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

function unwrap<T extends { ok: boolean; error?: string; state?: GameState }>(res: T): GameState {
  if (!res.ok) throw new Error(`action failed: ${res.error}`)
  return res.state!
}

function seeds(n: number): PlayerSeed[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))
}

// Play an entire hand using the given difficulty per seat (array index = seat).
// Returns the scoreHand lines.
function playHand(seed: number, difficulties: Difficulty[]): ReturnType<typeof scoreHand> {
  const g = createGame(seeds(difficulties.length), rng(seed))
  let s = g
  let guard = 0
  while (s.phase !== 'hand_over' && guard++ < 500) {
    const r = rng(seed + guard)
    if (s.phase === 'discard') {
      const actorId = s.playerOrder[s.currentPlayerIndex]
      const d = difficulties[s.playerOrder.indexOf(actorId)]
      const a = botAction(s, actorId, d, r)
      if (a.kind !== 'discard') throw new Error('expected discard action')
      s = unwrap(discardCard(s, actorId, a.cardId))
    } else if (s.phase === 'exchange') {
      const uncommitted = s.players.find((p) => !(p.passedLeft && p.passedRight))
      if (!uncommitted) throw new Error('exchange stuck')
      const d = difficulties[s.playerOrder.indexOf(uncommitted.id)]
      const a = botAction(s, uncommitted.id, d, r)
      if (a.kind !== 'pass') throw new Error('expected pass action')
      s = unwrap(passCards(s, uncommitted.id, a.leftCardId, a.rightCardId))
    } else if (s.phase === 'playing') {
      const actor = currentTrickActor(s)!
      const d = difficulties[s.playerOrder.indexOf(actor.id)]
      const a = botAction(s, actor.id, d, r)
      if (a.kind !== 'play') throw new Error('expected play action')
      s = unwrap(playCard(s, actor.id, a.cardId))
    } else {
      throw new Error(`unexpected phase ${s.phase}`)
    }
  }
  expect(s.phase).toBe('hand_over')
  return scoreHand(s)
}

describe('bot legality', () => {
  it('every difficulty always returns a legal play through a full hand', () => {
    for (const d of ['easy', 'medium', 'hard', 'expert'] as Difficulty[]) {
      for (const n of [3, 4]) {
        const g = createGame(seeds(n), rng(42))
        let s = g
        let guard = 0
        while (s.phase !== 'hand_over' && guard++ < 500) {
          const r = rng(guard)
          if (s.phase === 'discard') {
            const actorId = s.playerOrder[s.currentPlayerIndex]
            const a = botAction(s, actorId, d, r)
            if (a.kind !== 'discard') throw new Error('expected discard')
            expect(s.players.find((p) => p.id === actorId)!.hand.some((c) => c.id === a.cardId)).toBe(true)
            s = unwrap(discardCard(s, actorId, a.cardId))
          } else if (s.phase === 'exchange') {
            const uncommitted = s.players.find((p) => !(p.passedLeft && p.passedRight))!
            const a = botAction(s, uncommitted.id, d, r)
            if (a.kind !== 'pass') throw new Error('expected pass')
            const hand = s.players.find((p) => p.id === uncommitted.id)!.hand
            expect(hand.some((c) => c.id === a.leftCardId)).toBe(true)
            expect(hand.some((c) => c.id === a.rightCardId)).toBe(true)
            expect(a.leftCardId).not.toBe(a.rightCardId)
            s = unwrap(passCards(s, uncommitted.id, a.leftCardId, a.rightCardId))
          } else if (s.phase === 'playing') {
            const actor = currentTrickActor(s)!
            const legal = legalPlays(s, actor.id)
            const a = botAction(s, actor.id, d, r)
            if (a.kind !== 'play') throw new Error('expected play')
            expect(legal.some((c) => c.id === a.cardId)).toBe(true)
            s = unwrap(playCard(s, actor.id, a.cardId))
          }
        }
        expect(s.phase).toBe('hand_over')
      }
    }
  })

  it('isBotsTurn tracks the right actor in each phase', () => {
    const g = createGame(seeds(3), rng(5))
    const first = g.playerOrder[g.currentPlayerIndex]
    expect(isBotsTurn(g, first)).toBe(true)
    expect(isBotsTurn(g, g.playerOrder[(g.playerOrder.indexOf(first) + 1) % 3])).toBe(false)
  })
})

describe('bot decision quality', () => {
  it('hard discard poisons the imp pile: highest coins among weakest cards', () => {
    // Craft a hand with two lowest-number cards; the 6-coin one should go.
    const g = createGame(seeds(3), rng(9))
    const actorId = g.playerOrder[g.currentPlayerIndex]
    const s: GameState = {
      ...g,
      players: g.players.map((p) =>
        p.id === actorId
          ? {
              ...p,
              hand: [
                { id: 'x-2', suit: 'green', number: 2, coins: 6 },
                { id: 'x-3', suit: 'green', number: 3, coins: 1 },
                { id: 'x-20', suit: 'blue', number: 20, coins: 4 },
                { id: 'x-30', suit: 'red', number: 30, coins: 5 },
              ],
            }
          : p,
      ),
    }
    const cardId = chooseDiscard(s, actorId, 'hard', rng(1))
    expect(cardId).toBe('x-2')
  })

  it('hard exchange voids a suit when possible', () => {
    const g = createGame(seeds(3), rng(9))
    const actorId = g.playerOrder[g.currentPlayerIndex]
    const s: GameState = {
      ...g,
      players: g.players.map((p) =>
        p.id === actorId
          ? {
              ...p,
              hand: [
                { id: 'y-4', suit: 'green', number: 4, coins: 1 },
                { id: 'y-5', suit: 'green', number: 5, coins: 2 },
                { id: 'r-30', suit: 'red', number: 30, coins: 5 },
                { id: 'r-31', suit: 'red', number: 31, coins: 4 },
              ],
            }
          : p,
      ),
    }
    const { left, right } = chooseExchange(s, actorId, 'hard', rng(1))
    // Two same-suit cards in the bottom 4 → pass the pair to void red? The
    // bottom-4 by value here are y-4, y-5, r-30, r-31; first suit with 2 is
    // yellow → passes the yellow pair.
    const ids = [left, right].sort()
    expect(ids).toEqual(['y-4', 'y-5'].sort())
  })

  it('hard play while holding the bottle dumps instead of winning', () => {
    const g = createGame(seeds(3), rng(9))
    // Force a state: bottle on the bot, an easy trick it could win.
    const actorId = g.playerOrder[g.currentPlayerIndex]
    const s: GameState = {
      ...g,
      bottleHolderId: actorId,
      phase: 'playing',
      currentTrick: {
        leaderId: actorId,
        plays: [{ playerId: 'p1', card: { id: 'y-5', suit: 'green', number: 5, coins: 1 } }],
        price: 19,
      },
      players: g.players.map((p) =>
        p.id === actorId
          ? {
              ...p,
              hand: [
                { id: 'r-20', suit: 'red', number: 20, coins: 6 },
                { id: 'r-35', suit: 'red', number: 35, coins: 5 },
              ],
            }
          : p,
      ),
    }
    const cardId = choosePlay(s, actorId, 'hard', rng(1))
    // It could win with r-35 (beats y-5, non-trump) but must dump the bottle,
    // so it plays the cheapest card.
    expect(cardId).toBe('r-20')
  })

  it('hard play takes a worthwhile pot with the cheapest winning card', () => {
    const g = createGame(seeds(3), rng(9))
    // The trick below (p1 leads, p2 follows) makes the third seat the actor.
    const actorTmp = {
      ...g,
      phase: 'playing',
      currentTrick: {
        leaderId: 'p1',
        plays: [
          // red 30/32 are non-trumps (price 19); pot so far = 6+5
          { playerId: 'p1', card: { id: 'r-30', suit: 'red', number: 30, coins: 6 } },
          { playerId: 'p2', card: { id: 'r-32', suit: 'red', number: 32, coins: 5 } },
        ],
        price: 19,
      },
    } as GameState
    const actorId = currentTrickActor(actorTmp)!.id
    const s: GameState = {
      ...actorTmp,
      bottleHolderId: 'p1',
      players: g.players.map((p) =>
        p.id === actorId
          ? {
              ...p,
              hand: [
                { id: 'r-28', suit: 'red', number: 28, coins: 1 },
                { id: 'r-33', suit: 'red', number: 33, coins: 6 }, // would win but pricier
                { id: 'r-37', suit: 'red', number: 37, coins: 5 },
              ],
            }
          : p,
      ),
    }
    // Follow suit: r-28 (loses) or r-33/r-37 (win). Pot = 6+5+6 = 17 → worth
    // winning; cheapest winner is r-33.
    const cardId = choosePlay(s, actorId, 'hard', rng(1))
    expect(cardId).toBe('r-33')
  })
})

describe('tier ordering (seat-0 score vs two medium bots)', () => {
  // Average score of seat 0 over many seeded hands. Expert should outscore
  // hard, hard should outscore medium, medium should outscore easy.
  // 200 hands keeps the expert-vs-hard margin stable (single-hand variance
  // is large; 60 hands was too noisy).
  const N = 200

  function avgSeat0(d: Difficulty): number {
    let total = 0
    for (let seed = 100; seed < 100 + N; seed++) {
      const lines = playHand(seed, [d, 'medium', 'medium'])
      total += lines.find((l) => l.playerId === 'p0')!.score
    }
    return total / N
  }

  it('expert beats hard', () => {
    const expert = avgSeat0('expert')
    const hard = avgSeat0('hard')
    expect(expert).toBeGreaterThan(hard)
  })

  it('hard beats medium', () => {
    const hard = avgSeat0('hard')
    const medium = avgSeat0('medium')
    expect(hard).toBeGreaterThan(medium)
  })

  it('medium beats easy', () => {
    const medium = avgSeat0('medium')
    const easy = avgSeat0('easy')
    expect(medium).toBeGreaterThan(easy)
  })
})
