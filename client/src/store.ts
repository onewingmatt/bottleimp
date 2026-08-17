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
  gameOver: boolean
  error: string | null
  setConnected: (c: boolean) => void
  setRoom: (room: RoomState) => void
  setGame: (game: ClientGame) => void
  setScored: (results: ScoreResult[]) => void
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
  gameOver: false,
  error: null,

  setConnected: (c) => set({ connected: c }),
  setRoom: (room) =>
    set((s) => ({
      room,
      yourId: room.yourId ?? s.yourId,
      reconnectToken: room.reconnectToken ?? s.reconnectToken,
    })),
  setGame: (game) =>
    set((s) => ({
      game,
      gameOver: game.phase === 'game_over',
      // keep scored overlay until dismissed
      scored: game.phase === 'hand_over' || game.phase === 'game_over' ? s.scored : s.scored,
    })),
  setScored: (results) => set({ scored: results }),
  setGameOver: (v) => set({ gameOver: v }),
  dismissScored: () => set({ scored: null }),
  setError: (msg) => set({ error: msg }),
  reset: () =>
    set({
      room: null,
      yourId: null,
      reconnectToken: null,
      game: null,
      scored: null,
      gameOver: false,
      error: null,
    }),
}))
