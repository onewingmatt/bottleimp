# Bottle Imp — Online Multiplayer

A server-authoritative online implementation of **The Bottle Imp** — the classic trick-taking card game by Reiner Knizia (1995). This is a fan implementation; the rules belong to the designer/publisher, and this project uses original card numbers/mechanics with original visuals.

**Play with 3–4 players**, with **bots** that fill empty seats (easy/medium/hard, added from the lobby) and **take over disconnected humans** so the game never stalls. Reconnect by token to resume your seat.

## Stack
Mirrors the [medici](https://github.com/onewingmatt/medici) architecture:
- `shared/` — pure, deterministic game engine (TypeScript, RNG-injected)
- `server/` — Express + Socket.IO + better-sqlite3 (rooms, reconnect tokens, bot scheduler)
- `client/` — React + Vite + Zustand
- Docker for deployment

## Rules (classic 3–4p, 1995 edition)
- 36 suit cards numbered 1–37 in three colors (red/blue/yellow), each with a coin value 1–6. The neutral **19** sets the starting "price of the bottle".
- Deal all cards evenly (3p → 12 each, 4p → 9 each). Discard one card face-down to the Imp's Trick; pass one card to each neighbor (simultaneous exchange).
- Trick play: must follow suit (color) if possible. A card **lower than the current bottle price** is trump. If any trump is played, the **highest trump** wins; otherwise the highest card wins.
- The trick winner takes the trick; if their winning card is a trump, they take the Bottle Imp and the price falls to that card's number. The previous price card goes to the former bottle owner's won tricks.
- Hand ends when all cards are played. Score coins on cards in your won tricks — **except** the player holding the Bottle, who scores **negative** coins from the Imp's Trick and ignores their own tricks.
- **Matches:** two modes, host picks in the lobby. **First to N** (target
  score, default 100) or **Best of N** (fixed hands, highest total wins).
  Totals persist across hands and survive reconnects.

## Run locally
```bash
npm install
npm run server          # API + socket server on :3001

# in a second terminal:
cd client && npm install && npm run dev   # Vite dev server
```
Open the Vite URL, create a room, add bots, share the 5-char room code.

## Tests
```bash
npm test          # vitest (engine, scoring, bot decisions)
npm run typecheck # tsc across shared/server/client
```

## Deploy
```bash
rsync -av --exclude node_modules --exclude .git --exclude dist ./ user@host:/opt/stacks/bottleimp/
ssh user@host "cd /opt/stacks/bottleimp && docker compose up -d --build"
```
The container serves the built client + API on :3001.

## Rules audit
See [RULES-AUDIT.md](./RULES-AUDIT.md) for rule interpretations and flagged ambiguities.
