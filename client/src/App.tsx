import { useEffect } from 'react'
import { useStore } from './store'
import { connect } from './socket'
import { Lobby } from './components/Lobby'
import { Table } from './components/Table'

export default function App() {
  const connected = useStore((s) => s.connected)
  const room = useStore((s) => s.room)
  const error = useStore((s) => s.error)

  useEffect(() => {
    connect()
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 20 }}>
      <h1>🧪 The Bottle Imp</h1>
      <div className="muted" style={{ marginBottom: 12 }}>
        {connected ? 'connected' : 'connecting…'}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!room ? (
        <Lobby />
      ) : room.inGame ? (
        <Table />
      ) : (
        <Lobby />
      )}
    </div>
  )
}
