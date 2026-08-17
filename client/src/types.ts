import type { Card, Difficulty } from '../../shared/types'

// Client-side view of a player (hand only for self).
export interface ClientPlayer {
  id: string
  name: string
  hand?: Card[]
  handCount: number
  tricksWon: Card[][]
  disconnected: boolean
  isBot: boolean
  difficulty?: Difficulty
}

export type ClientPhase = 'discard' | 'exchange' | 'playing' | 'hand_over' | 'game_over'

export interface ClientTrick {
  leaderId: string
  plays: { playerId: string; card: Card }[]
  price: number
}

export interface ClientGame {
  players: ClientPlayer[]
  playerOrder: string[]
  phase: ClientPhase
  currentPlayerIndex: number
  currentTrick: ClientTrick | null
  bottlePrice: number
  bottleHolderId: string | null
  impTrick?: Card[]
  impTrickCount: number
  history: unknown[]
  handNumber: number
  finalResults?: { playerId: string; score: number; heldBottle: boolean }[]
}

export interface RoomPlayer {
  id: string
  name: string
  isBot: boolean
  difficulty: Difficulty
  disconnected: boolean
}

export interface RoomState {
  code: string
  hostId: string
  inGame: boolean
  players: RoomPlayer[]
  reconnectToken?: string
  yourId?: string
}

export interface ScoreResult {
  playerId: string
  score: number
  heldBottle: boolean
  trickCoins: number
  impTrickCoins: number
}
