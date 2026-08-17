// Zustand store — single source of truth for the client UI.
import { create } from 'zustand'
import type { ClientGame, RoomState, ScoreResult } from './types'

export interface UIState {
  connected: boolean
  room: RoomState | null
  yourId: string | null
  reconnectToken: string | null
  game: ClientGame | null
  scored: ScoreResult[] | null
  totals: Record<string, number> | null
  matchWinnerId: string | null
  matchTarget: number
  matchMode: 'target' | 'hands'
  matchHands: number
  handsPlayed: number
  fastBots: boolean
  gameOver: boolean
  error: string | null
  setConnected: (c: boolean) => void
  setRoom: (room: RoomState) => void
  setGame: (game: ClientGame) => void
  setScored: (results: ScoreResult[], totals?: Record<string, number>, matchWinnerId?: string | null, matchTarget?: number) => void
  setGameOver: (v: boolean) => void
  dismissScored: () => void
  setError: (msg: string | null) => void
  reset: () => void
}

export const useStore = create<UIState>((set) => ({
  connected: false,
  room: null,
  yourId: null,
  reconnectToken: null,
  game: null,
  scored: null,
  totals: null,
  matchWinnerId: null,
  matchTarget: 100,
  matchMode: 'target',
  matchHands: 3,
  handsPlayed: 0,
  fastBots: false,
  gameOver: false,
  error: null,

  setConnected: (c) => set({ connected: c }),
  setRoom: (room) =>
    set((s) => ({
      room,
      yourId: room.yourId ?? s.yourId,
      reconnectToken: room.reconnectToken ?? s.reconnectToken,
      matchTarget: room.matchTarget ?? s.matchTarget,
      matchWinnerId: room.matchWinnerId ?? s.matchWinnerId,
      matchMode: room.matchMode ?? s.matchMode,
      matchHands: room.matchHands ?? s.matchHands,
      handsPlayed: room.handsPlayed ?? s.handsPlayed,
      fastBots: room.fastBots ?? s.fastBots,
    })),
  setGame: (game) =>
    set((s) => ({
      game,
      gameOver: game.phase === 'game_over',
      // Keep the scored overlay while the summary is up; clear it as soon as
      // the phase moves on (continue/restart) so it can't cover a new hand.
      scored: game.phase === 'hand_over' || game.phase === 'game_over' ? s.scored : null,
    })),
  setScored: (results, totals, matchWinnerId, matchTarget) =>
    set({
      scored: results,
      totals: totals ?? null,
      matchWinnerId: matchWinnerId ?? null,
      matchTarget: matchTarget ?? 100,
    }),
  setGameOver: (v) => set({ gameOver: v }),
  dismissScored: () => set({ scored: null }), // totals survive — they're the running session record
  setError: (msg) => set({ error: msg }),
  reset: () =>
    set({
      room: null,
      yourId: null,
      reconnectToken: null,
      game: null,
      scored: null,
      totals: null,
      matchWinnerId: null,
      matchTarget: 100,
      matchMode: 'target',
      matchHands: 3,
      handsPlayed: 0,
      fastBots: false,
      gameOver: false,
      error: null,
    }),
}))
