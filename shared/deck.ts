// Deck construction and shuffling.
import { COIN_BY_NUMBER, SUIT_NUMBERS } from './constants'
import type { Card } from './types'

export type RNG = () => number // returns [0, 1)

// The neutral "19" start card is not a playable suit card; it is a constant
// price marker. The playable deck is the 36 suit cards numbered 1-37
// (excluding 19) across three colors.
export function buildDeck(): Card[] {
  const cards: Card[] = []
  for (const [suit, numbers] of Object.entries(SUIT_NUMBERS) as [keyof typeof SUIT_NUMBERS, number[]][]) {
    for (const number of numbers) {
      cards.push({
        id: `${suit}-${number}`,
        suit,
        number,
        coins: COIN_BY_NUMBER[number],
      })
    }
  }
  return cards
}

// Fisher-Yates with injected RNG (deterministic under a seeded RNG).
export function shuffle<T>(arr: T[], rng: RNG): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
