import { useState } from 'react'
import { useStore } from '../store'
import { getSocket } from '../socket'
import type { Card } from '../../../shared/types'

function CardView({ card, onClick, selected, playable }: {
  card: Card
  onClick?: (id: string) => void
  selected?: boolean
  playable?: boolean
}) {
  return (
    <div
      className={`card suit-${card.suit}${selected ? ' selected' : ''}${playable ? ' playable' : ' disabled'}`}
      onClick={() => onClick?.(card.id)}
    >
      <span className="card-suit">{card.suit}</span>
      <span className="card-number">{card.number}</span>
      <span className="card-coins">{'●'.repeat(card.coins)}</span>
    </div>
  )
}

export function Table() {
  const game = useStore((s) => s.game)
  const yourId = useStore((s) => s.yourId)
  const scored = useStore((s) => s.scored)
  // Local (not store) selection for the exchange: exactly two distinct cards.
  const [exchangeSel, setExchangeSel] = useState<string[]>([])

  if (!game) return <div className="panel">Waiting for game…</div>
  const g = game

  const me = game.players.find((p) => p.id === yourId)
  const myHand = me?.hand ?? []
  const trick = game.currentTrick
  const myTurn =
    game.phase === 'discard'
      ? game.playerOrder[game.currentPlayerIndex] === yourId
      : game.phase === 'exchange'
        ? true // everyone passes simultaneously
        : game.phase === 'playing' && !!trick
          ? trick.plays.length < game.players.length &&
            game.playerOrder[(game.playerOrder.indexOf(trick.leaderId) + trick.plays.length) % game.players.length] === yourId
          : false

  // Legal plays for highlight (only in playing phase).
  const legalIds = (() => {
    if (g.phase !== 'playing' || !trick) return new Set<string>()
    const leader = trick.plays[0]
    if (!leader) return new Set(myHand.map((c) => c.id)) // leader plays anything
    const canFollow = myHand.filter((c) => c.suit === leader.card.suit)
    return new Set((canFollow.length > 0 ? canFollow : myHand).map((c) => c.id))
  })()

  const socket = getSocket()

  function handleCardClick(id: string) {
    if (g.phase === 'discard') {
      if (myTurn) socket?.emit('game:discard', { cardId: id })
    } else if (g.phase === 'exchange') {
      // Toggle this card in/out of the two-card pass selection.
      setExchangeSel((sel) =>
        sel.includes(id) ? sel.filter((x) => x !== id) : sel.length < 2 ? [...sel, id] : sel,
      )
    } else if (g.phase === 'playing') {
      if (myTurn && legalIds.has(id)) socket?.emit('game:play', { cardId: id })
    }
  }

  function confirmPass() {
    if (exchangeSel.length !== 2) return
    const [leftCardId, rightCardId] = exchangeSel
    socket?.emit('game:pass', { leftCardId, rightCardId })
  }

  const bottleHolder = game.players.find((p) => p.id === game.bottleHolderId)

  return (
    <div style={{ width: '100%', maxWidth: 900 }}>
      {/* Opponents */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginBottom: 10 }}>
        {game.players.filter((p) => p.id !== yourId).map((p) => (
          <div key={p.id} className="panel" style={{ minWidth: 140, margin: 0 }}>
            <div style={{ fontWeight: 700 }}>
              {p.name} {p.isBot && <span className="muted">(bot)</span>}
            </div>
            <div className="muted">{p.handCount} cards</div>
            <div className="muted">{p.tricksWon.length} tricks</div>
            {game.bottleHolderId === p.id && <div style={{ color: 'var(--accent-2)' }}>🧪 holds bottle</div>}
            {p.disconnected && <div style={{ color: 'var(--danger)' }}>disconnected</div>}
          </div>
        ))}
      </div>

      {/* Table center */}
      <div className="panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div>
            <div className="muted">Bottle price</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{game.bottlePrice}</div>
          </div>
          <div style={{ fontSize: '1.4rem' }}>
            {bottleHolder ? `🧪 held by ${bottleHolder.name}` : '🧪 in the middle'}
          </div>
          <div className="muted">
            Imp's trick: {game.impTrickCount} card{game.impTrickCount === 1 ? '' : 's'}
          </div>
        </div>

        {/* Current trick */}
        {trick ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', minHeight: 120 }}>
            {game.playerOrder.map((pid) => {
              const play = trick.plays.find((x) => x.playerId === pid)
              const player = game.players.find((p) => p.id === pid)
              return (
                <div key={pid} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {play ? (
                    <CardView card={play.card} />
                  ) : (
                    <div className="card disabled" style={{ opacity: 0.25, height: 92 }}>
                      <span className="card-number">?</span>
                    </div>
                  )}
                  <span className="muted" style={{ fontSize: '0.75rem' }}>
                    {player?.name}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="muted">Trick complete — waiting for next lead</div>
        )}

        {game.phase === 'discard' && myTurn && (
          <div style={{ color: 'var(--accent-2)' }}>Select one card to discard face-down</div>
        )}
        {game.phase === 'exchange' && (
          <div style={{ color: 'var(--accent-2)' }}>
            Pass one card left and one right — select two cards ({exchangeSel.length}/2)
          </div>
        )}
        {game.phase === 'playing' && myTurn && (
          <div style={{ color: 'var(--accent-2)' }}>Play a card (must follow suit if possible)</div>
        )}
      </div>

      {/* My hand */}
      <div className="panel" style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
        {myHand.length === 0 && <div className="muted">No cards</div>}
        {myHand.map((c) => (
          <CardView
            key={c.id}
            card={c}
            onClick={() => handleCardClick(c.id)}
            selected={exchangeSel.includes(c.id)}
            playable={game.phase === 'playing' ? myTurn && legalIds.has(c.id) : myTurn}
          />
        ))}
      </div>

      {/* Exchange confirm */}
      {game.phase === 'exchange' && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10, gap: 8 }}>
          <button onClick={confirmPass} disabled={exchangeSel.length !== 2}>
            Pass 2 selected cards
          </button>
          <button className="secondary" onClick={() => setExchangeSel([])}>
            Clear
          </button>
        </div>
      )}

      {/* Hand-over / game over overlay */}
      {scored && (
        <div className="overlay">
          <div className="panel">
            <h2>Hand over</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', margin: '12px 0' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Player</th>
                  <th>Tricks</th>
                  <th>Bottle?</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {scored.map((r) => {
                  const p = game.players.find((x) => x.id === r.playerId)
                  return (
                    <tr key={r.playerId}>
                      <td>{p?.name}</td>
                      <td style={{ textAlign: 'center' }}>{r.trickCoins}</td>
                      <td style={{ textAlign: 'center' }}>
                        {r.heldBottle ? `-${r.impTrickCoins} (bottle)` : '—'}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700 }}>{r.score}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <button onClick={() => socket?.emit('game:continue')} style={{ width: '100%' }}>
              Continue
            </button>
            <button
              className="secondary"
              onClick={() => socket?.emit('game:restart')}
              style={{ width: '100%', marginTop: 8 }}
            >
              Play again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
