// Core game types — shared between engine, server, and client.
import type { Suit } from './constants'

export interface Card {
  id: string
  suit: Suit
  number: number // 1-37, unique
  coins: number // 1-6
}

export type Difficulty = 'easy' | 'medium' | 'hard'

export type Phase = 'discard' | 'exchange' | 'playing' | 'hand_over' | 'game_over'

export interface PlayerState {
  id: string
  name: string
  hand: Card[] // own cards (server keeps full; clients see only own)
  tricksWon: Card[][] // tricks won, each trick = array of cards
  discarded: boolean // has discarded this hand
  passedLeft: boolean // has committed a left-pass card
  passedRight: boolean // has committed a right-pass card
  disconnected: boolean
  isBot: boolean
  difficulty?: Difficulty
}

export interface TrickPlay {
  playerId: string
  card: Card
}

export interface TrickState {
  leaderId: string
  plays: TrickPlay[] // in play order
  // bottle price at the time this trick started (public)
  price: number
}

export type EngineEvent =
  | { type: 'hand_start'; dealerId: string; ts: number }
  | { type: 'discard'; playerId: string; ts: number }
  | { type: 'exchange'; playerId: string; ts: number }
  | { type: 'trick_start'; leaderId: string; price: number; ts: number }
  | { type: 'play'; playerId: string; card: Card; ts: number }
  | {
      type: 'trick_end'
      winnerId: string
      winningCard: Card
      bottleChanged: boolean
      newPrice: number | null
      ts: number
    }
  | { type: 'hand_end'; ts: number }

export interface GameState {
  players: PlayerState[]
  playerOrder: string[] // fixed seating order (clockwise)
  phase: Phase
  currentPlayerIndex: number // index into playerOrder for trick play
  currentTrick: TrickState | null
  bottlePrice: number // current price (starts 19)
  bottleHolderId: string | null // null = nobody owns the bottle yet
  impTrick: Card[] // face-down discards under the 19 (hidden until scoring)
  previousPrice: number // the card that was the previous price (for transfer)
  history: EngineEvent[]
  handNumber: number
  // pending exchange: cards passed to each player (playerId -> [leftCard, rightCard])
  incoming: Record<string, Card[]>
  finalResults?: { playerId: string; score: number; heldBottle: boolean }[]
}

export interface PlayerSeed {
  id: string
  name: string
}

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string }
