// Socket.IO connection + event wiring.
import { io, type Socket } from 'socket.io-client'
import { useStore } from './store'

let socket: Socket | null = null

export function connect(): Socket {
  if (socket) return socket
  socket = io()
  socket.on('connect', () => useStore.getState().setConnected(true))
  socket.on('disconnect', () => useStore.getState().setConnected(false))

  socket.on('room:state', (room) => {
    useStore.getState().setRoom(room)
  })
  socket.on('game:board', ({ game }) => {
    useStore.getState().setGame(game)
  })
  socket.on('game:scored', ({ game, results }) => {
    useStore.getState().setGame(game)
    useStore.getState().setScored(results)
    useStore.getState().setGameOver(game.phase === 'game_over')
  })
  socket.on('error', ({ message }) => {
    useStore.getState().setError(message)
  })
  socket.on('room:left', () => {
    useStore.getState().reset()
  })
  socket.on('room:closed', () => {
    useStore.getState().reset()
    useStore.getState().setError('Room closed by host')
  })
  return socket
}

export function getSocket(): Socket | null {
  return socket
}
