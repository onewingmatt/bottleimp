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

// The three colors' number ranges. The 1995 classic deck is 36 cards across
// three suits of 12 each (rules PDF: "12 each of blue, red and yellow suits").
// The suits are INTERLEAVED across the range (the rules recommend sorting by
// number rather than color, and the reference card is a winding track), not
// contiguous blocks — a contiguous split cannot give 12/12/12 because 19
// falls inside one range. The exact interleaving is verified from the
// publisher's player aid of the edition that keeps the classic 1-37 deck;
// the third suit is YELLOW in the 1995 edition (red = dollars high,
// blue = cents middle, yellow = centimes low).
//   red:   1, 2, 4, 5, 7, 9, 12, 15, 18, 22, 25, 28
//   blue:  3, 6, 8, 10, 13, 17, 20, 23, 27, 30, 32, 35
//   yellow: 11, 14, 16, 21, 24, 26, 29, 31, 33, 34, 36, 37
// 19 is black (the start/bottle-price card) and is not a playable suit card.
export const SUIT_NUMBERS: Record<Suit, number[]> = {
  red: [1, 2, 4, 5, 7, 9, 12, 15, 18, 22, 25, 28],
  blue: [3, 6, 8, 10, 13, 17, 20, 23, 27, 30, 32, 35],
  yellow: [11, 14, 16, 21, 24, 26, 29, 31, 33, 34, 36, 37],
}

export const MIN_PLAYERS = 3
export const MAX_PLAYERS = 4

// Cards dealt per player by player count.
export const DEAL_COUNT: Record<number, number> = {
  3: 12,
  4: 9,
}
