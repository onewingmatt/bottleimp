import { useState } from 'react'
import { useStore } from '../store'
import { getSocket } from '../socket'
import type { Difficulty } from '../../../shared/types'

export function Lobby() {
  const room = useStore((s) => s.room)
  const yourId = useStore((s) => s.yourId)
  const [name, setName] = useState(localStorage.getItem('bottleimp:name') ?? '')
  const [code, setCode] = useState('')
  const [createName, setCreateName] = useState(localStorage.getItem('bottleimp:name') ?? 'Player')

  const socket = getSocket()

  function handleCreate() {
    const n = createName.trim() || 'Player'
    localStorage.setItem('bottleimp:name', n)
    socket?.emit('room:create', { playerName: n })
  }

  function handleJoin() {
    const n = name.trim() || 'Player'
    localStorage.setItem('bottleimp:name', n)
    socket?.emit('room:join', { code: code.trim().toUpperCase(), playerName: n })
  }

  if (room) {
    const isHost = room.hostId === yourId
    return (
      <div className="panel" style={{ minWidth: 420 }}>
        <h2>Room {room.code}</h2>
        <div style={{ marginBottom: 12 }}>
          <span className="muted">Share this code with friends:</span>{' '}
          <strong style={{ fontSize: '1.4rem', letterSpacing: 2 }}>{room.code}</strong>
        </div>
        {!room.inGame && isHost && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="muted">Match:</span>
            <button
              className={room.matchMode === 'target' ? '' : 'secondary'}
              onClick={() => socket?.emit('game:setMatch', { mode: 'target' })}
              style={{ padding: '4px 10px', fontSize: '0.8rem' }}
            >
              First to
            </button>
            <button
              className={room.matchMode === 'hands' ? '' : 'secondary'}
              onClick={() => socket?.emit('game:setMatch', { mode: 'hands' })}
              style={{ padding: '4px 10px', fontSize: '0.8rem' }}
            >
              Best of
            </button>
            {room.matchMode === 'target' ? (
              <>
                <input
                  type="number"
                  min={10}
                  max={1000}
                  value={room.matchTarget}
                  onChange={(e) => socket?.emit('game:setMatch', { mode: 'target', target: Number(e.target.value) })}
                  style={{ ...inputStyle, width: 80, padding: '6px 8px' }}
                />
                <span className="muted">points</span>
              </>
            ) : (
              <>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={room.matchHands}
                  onChange={(e) => socket?.emit('game:setMatch', { mode: 'hands', hands: Number(e.target.value) })}
                  style={{ ...inputStyle, width: 80, padding: '6px 8px' }}
                />
                <span className="muted">hands</span>
              </>
            )}
          </div>
        )}
        {room.inGame && (
          <div className="muted" style={{ marginBottom: 12 }}>
            {room.matchMode === 'target'
              ? `Match: first to ${room.matchTarget} points`
              : `Match: best of ${room.matchHands} hands (hand ${Math.min(room.handsPlayed + 1, room.matchHands)}/${room.matchHands})`}
          </div>
        )}
        <div>
          <h3 className="muted" style={{ marginBottom: 6 }}>
            Players ({room.players.length}/4)
          </h3>
          {room.players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
              <span>
                {p.name} {p.isBot && <span className="muted">(bot · {p.difficulty})</span>}
                {p.id === room.hostId && <span className="muted"> · host</span>}
              </span>
              {isHost && p.isBot && (
                <button className="secondary" onClick={() => socket?.emit('remove_bot', { playerId: p.id })}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        {isHost && (
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['easy', 'medium', 'hard', 'expert'] as Difficulty[]).map((d) => (
              <button
                key={d}
                className="secondary"
                disabled={room.players.length >= 4}
                onClick={() => socket?.emit('add_bot', { difficulty: d })}
              >
                + Bot ({d})
              </button>
            ))}
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          {isHost && (
            <button disabled={room.players.length < 3} onClick={() => socket?.emit('game:start')}>
              Start game ({room.players.length}/4)
            </button>
          )}
          <button className="danger" onClick={() => socket?.emit(isHost ? 'room:close' : 'room:leave')}>
            {isHost ? 'Close room' : 'Leave'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel" style={{ minWidth: 380 }}>
      <h2>Create a room</h2>
      <input
        placeholder="Your name"
        value={createName}
        onChange={(e) => setCreateName(e.target.value)}
        style={{ ...inputStyle, marginBottom: 10 }}
      />
      <button onClick={handleCreate} style={{ width: '100%' }}>
        Create room
      </button>
      <hr style={{ margin: '20px 0', border: '1px solid var(--panel-2)' }} />
      <h2>Join a room</h2>
      <input
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ ...inputStyle, marginBottom: 10 }}
      />
      <input
        placeholder="Room code (5 chars)"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        maxLength={5}
        style={{ ...inputStyle, marginBottom: 10, textTransform: 'uppercase' }}
      />
      <button onClick={handleJoin} style={{ width: '100%' }} disabled={code.trim().length !== 5}>
        Join room
      </button>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--panel-2)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  fontSize: '1rem',
}
