// Shared game constants — The Bottle Imp (1995 classic, 3-4 players)
// Single source of truth for both engine and client.

export const SUITS = ['red', 'blue', 'yellow'] as const
export type Suit = (typeof SUITS)[number]

// Coin values per card number. Classic deck: 36 suit cards numbered 1-37
// across three colors; each card carries 1-6 coins for scoring.
// Assignment: red = high numbers (mostly high coins), blue = middle,
// yellow = low numbers. The exact per-number coin layout varies by edition;
// this consistent assignment is documented in RULES-AUDIT.
export const COIN_BY_NUMBER: Record<number, number> = (() => {
  const coins: Record<number, number> = {}
  // Numbers 1-37 (excluding the neutral 19 start card), coins 1-6.
  // Pattern: cycle 1..6 across the range so roughly 6 of each.
  const seq = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2]
  // Assign to numbers 1..37 excluding 19
  let i = 0
  for (let n = 1; n <= 37; n++) {
    if (n === 19) continue
    coins[n] = seq[i % seq.length]
    i++
  }
  return coins
})()

export const DECK_SIZE = 36
export const START_PRICE = 19

// The three colors' number ranges (red mostly high, blue middle, yellow low).
export const SUIT_NUMBERS: Record<Suit, number[]> = (() => {
  // Partition 1..37 (minus 19) into three ranges:
  // yellow: low 1-12, blue: mid 13-24, red: high 25-37 (19 removed from blue).
  const yellow: number[] = []
  const blue: number[] = []
  const red: number[] = []
  for (let n = 1; n <= 37; n++) {
    if (n === 19) continue
    if (n <= 12) yellow.push(n)
    else if (n >= 25) red.push(n)
    else blue.push(n)
  }
  return { yellow, blue, red }
})()

export const MIN_PLAYERS = 3
export const MAX_PLAYERS = 4

// Cards dealt per player by player count.
export const DEAL_COUNT: Record<number, number> = {
  3: 12,
  4: 9,
}
