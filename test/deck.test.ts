import { describe, expect, it } from 'vitest'
import { COIN_BY_NUMBER, SUITS, SUIT_NUMBERS } from '../shared/constants'
import { buildDeck } from '../shared/deck'

// Locks the deck to the classic 1-37 distribution: 36 suit cards across
// three suits of 12 each (rules PDF: "12 each of blue, red and yellow suits"),
// suits INTERLEAVED across the range (a contiguous split cannot give 12/12/12
// because 19 falls inside one range). Third suit is YELLOW in the 1995
// edition (red = dollars high, blue = cents middle, yellow = centimes low).
//    red:   1, 2, 4, 5, 7, 9, 12, 15, 18, 22, 25, 28
//    blue:  3, 6, 8, 10, 13, 17, 20, 23, 27, 30, 32, 35
//    yellow: 11, 14, 16, 21, 24, 26, 29, 31, 33, 34, 36, 37
// 19 is black (start/bottle-price card), not a playable suit card.
const EXPECTED_SUITS: Record<string, number[]> = {
  red: [1, 2, 4, 5, 7, 9, 12, 15, 18, 22, 25, 28],
  blue: [3, 6, 8, 10, 13, 17, 20, 23, 27, 30, 32, 35],
  yellow: [11, 14, 16, 21, 24, 26, 29, 31, 33, 34, 36, 37],
}

describe('deck integrity', () => {
  it('has exactly 36 playable cards', () => {
    const deck = buildDeck()
    expect(deck).toHaveLength(36)
  })

  it('contains every number 1-37 except the neutral 19 exactly once', () => {
    const numbers = buildDeck().map((c) => c.number).sort((a, b) => a - b)
    const expected: number[] = []
    for (let n = 1; n <= 37; n++) if (n !== 19) expected.push(n)
    expect(numbers).toEqual(expected)
  })

  it('matches the classic suit layout (12 per suit, interleaved)', () => {
    for (const suit of SUITS) {
      const got = buildDeck()
        .filter((c) => c.suit === suit)
        .map((c) => c.number)
        .sort((a, b) => a - b)
      expect(got).toEqual(EXPECTED_SUITS[suit])
      expect(got).toHaveLength(12)
    }
  })

  it('assigns coin values 1-6 to every card', () => {
    for (const c of buildDeck()) {
      expect(c.coins).toBeGreaterThanOrEqual(1)
      expect(c.coins).toBeLessThanOrEqual(6)
    }
    // And COIN_BY_NUMBER covers every playable number.
    for (let n = 1; n <= 37; n++) {
      if (n === 19) continue
      expect(COIN_BY_NUMBER[n]).toBeGreaterThanOrEqual(1)
      expect(COIN_BY_NUMBER[n]).toBeLessThanOrEqual(6)
    }
  })

  it('uses exactly the three documented suits', () => {
    expect(SUITS).toEqual(['red', 'blue', 'yellow'])
    const deckSuits = new Set(buildDeck().map((c) => c.suit))
    expect(deckSuits).toEqual(new Set(SUITS))
  })

  it('keeps SUIT_NUMBERS in sync with the built deck', () => {
    for (const suit of SUITS) {
      const fromConstants = [...SUIT_NUMBERS[suit]].sort((a, b) => a - b)
      const fromDeck = buildDeck()
        .filter((c) => c.suit === suit)
        .map((c) => c.number)
        .sort((a, b) => a - b)
      expect(fromConstants).toEqual(fromDeck)
    }
  })
})
