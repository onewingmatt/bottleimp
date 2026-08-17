// End-of-hand scoring. Pure, no I/O.
import type { GameState } from './types'

export interface ScoreLine {
  playerId: string
  score: number
  heldBottle: boolean
  trickCoins: number // coins from own won tricks (ignored if heldBottle)
  impTrickCoins: number // negative coins from the Imp's Trick (if heldBottle)
}

// Score a finished hand:
// - Each player scores the sum of coins on cards in their won tricks.
// - The player holding the Bottle Imp instead scores the NEGATIVE of the
//   coins in the Imp's Trick (the face-down discards under the 19), and
//   ignores their own won-trick coins.
export function scoreHand(state: GameState): ScoreLine[] {
  const lines: ScoreLine[] = state.players.map((p) => {
    const trickCoins = p.tricksWon.reduce(
      (sum, trick) => sum + trick.reduce((s, c) => s + c.coins, 0),
      0,
    )
    const heldBottle = p.id === state.bottleHolderId
    const impTrickCoins = state.impTrick.reduce((sum, c) => sum + c.coins, 0)
    const score = heldBottle ? -impTrickCoins : trickCoins
    return { playerId: p.id, score, heldBottle, trickCoins, impTrickCoins }
  })
  return lines
}

export function winnerIds(lines: ScoreLine[]): string[] {
  const max = Math.max(...lines.map((l) => l.score))
  return lines.filter((l) => l.score === max).map((l) => l.playerId)
}
