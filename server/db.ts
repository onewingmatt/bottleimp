// SQLite persistence — single rooms table, full room state as JSON blob.
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { Room } from './rooms'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'bottleimp.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

const upsert = db.prepare(`
  INSERT INTO rooms (code, data, updated_at) VALUES (@code, @data, @updated_at)
  ON CONFLICT(code) DO UPDATE SET data = @data, updated_at = @updated_at
`)
const selectAll = db.prepare('SELECT data FROM rooms')
const remove = db.prepare('DELETE FROM rooms WHERE code = ?')

export function saveRoom(room: Room): void {
  upsert.run({
    code: room.code,
    data: JSON.stringify(room),
    updated_at: Date.now(),
  })
}

export function deleteRoom(code: string): void {
  remove.run(code)
}

export function loadRooms(): Room[] {
  const rows = selectAll.all() as { data: string }[]
  const rooms: Room[] = []
  for (const row of rows) {
    try {
      rooms.push(JSON.parse(row.data) as Room)
    } catch {
      // skip corrupt rows
    }
  }
  return rooms
}
