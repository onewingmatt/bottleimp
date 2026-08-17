// Tiny in-memory rate limiter for room:join. The room-code space is ~33M
// combos (5 chars from a 32-char alphabet) so a determined attacker could
// enumerate open rooms by hammering join. This is not a general DDoS defense
// (it lives in one process, memory only) — it just makes enumeration
// impractical per IP and per socket.
interface Bucket {
  count: number
  resetAt: number
}

const WINDOW_MS = Number(process.env.RL_WINDOW_MS ?? 10_000)
const MAX_JOINS = Number(process.env.RL_MAX_JOINS ?? 20) // per 10s window

const buckets = new Map<string, Bucket>()

export function isJoinRateLimited(key: string): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  b.count += 1
  if (b.count > MAX_JOINS) return true
  return false
}

// Opportunistic cleanup so the map can't grow forever with dead keys.
const CLEANUP_EVERY = 4096
let ops = 0
export function maybePruneRateLimits(): void {
  ops += 1
  if (ops % CLEANUP_EVERY !== 0) return
  const now = Date.now()
  for (const [k, v] of buckets) {
    if (now >= v.resetAt) buckets.delete(k)
  }
}

export function rateLimitStats(): { size: number; windowMs: number; maxJoins: number } {
  return { size: buckets.size, windowMs: WINDOW_MS, maxJoins: MAX_JOINS }
}
