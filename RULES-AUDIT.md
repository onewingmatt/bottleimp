# Rules Audit — The Bottle Imp (classic 3–4p, 1995 edition)

This project is a fan implementation. The game rules are copyright Reiner Knizia and the original publisher. This file records the rule interpretations and ambiguities chosen while implementing, so nothing is silently guessed.

## Sources
- UltraBoardGames rules summary (36 suit cards, 1 start value card, 1 Bottle Imp card, 4 reference cards)
- board-game-rules.com summary (cards numbered 1–37 in three colors, neutral 19, coins 1–6, trump below price)
- BGG forum threads for the 1995 edition

## Deck
- **36 suit cards**, numbered **1–37**, in **three colors** (red, blue, **yellow** — the 1995 edition's third suit is yellow, not green), each color holding exactly **12 cards** (rules PDF: "12 each of blue, red and yellow suits").
- Suit layout is **interleaved**, not contiguous blocks. A contiguous split (yellow 1–12, blue 13–24, red 25–37) cannot satisfy 12/12/12 because 19 falls inside one range, and the rules recommend sorting by number rather than color, implying interleaving. The exact interleaving is taken from the publisher's player aid of the edition that keeps the classic 1–37 distribution:
  - red:   1, 2, 4, 5, 7, 9, 12, 15, 18, 22, 25, 28
  - blue:  3, 6, 8, 10, 13, 17, 20, 23, 27, 30, 32, 35
  - yellow: 11, 14, 16, 21, 24, 26, 29, 31, 33, 34, 36, 37
  Locked by `test/deck.test.ts`.
- Each card has a **coin value 1–6** for scoring (small bottle icons on the card face).
- **1 neutral card "19"** — the start value / current price of the Bottle. It is not a playable suit card; it sits face-up and is never played to tricks.
- 37 physical cards total (36 + 19 + Bottle token + reference cards).
- Coin-value assignment: the exact per-card coin distribution is NOT printed on any public reference we could find (the reference card in the rules shows suit colors only; the per-card coins are printed only on physical cards, and the 1995 reference card scan is too low-res to read reliably). We assign coins 1–6 per a consistent cycling pattern in `shared/constants.ts` (COIN_BY_NUMBER). **Flagged**: exact coin layout varies by edition (Joe Huber, Games Journal 2002: later editions "changed colour and scoring values"); this affects only scoring totals, not legality of play. The 1–6 range and the "higher points near the bottle price" design are verified; the exact per-number values are the one remaining unverified assumption.

## Deal
- 3 players: 12 cards each; 4 players: 9 each. All 36 suit cards are dealt.

## Discard & exchange
- Each player discards **one card face-down** to the **Imp's Trick** pile (under the 19). Hidden; only revealed at scoring.
- **Exchange:** simultaneously pass one card face-down to the **left** neighbor and one to the **right** neighbor; then take the two cards passed to you.
- Order chosen: discard first, then exchange. (Rules summary lists "each player discards" then "exchanges" — consistent.)

## Trick-taking
- Clockwise from the player left of the dealer (dealer random; leader = left of dealer).
- **Follow suit** (color) if possible; otherwise play any card.
- **Trump:** a card is trump when its number is **lower than the current bottle price** (starts at 19).
- **Resolution:**
  - If **any** trump was played, the **highest trump** (highest number below the price) wins, regardless of suit.
  - If **no** trump was played, the **highest number** wins, regardless of suit (normal high-card trick).
- No ties possible (all 36 card numbers are unique).

## Bottle Imp transfer
- If the trick winner's winning card is a trump (below price), they **take the Bottle Imp token**; the winning card becomes the **new bottle price** (lower).
- The card that denoted the **previous price** goes to the **former bottle owner**, turned over and added to their won tricks.
- If the new owner already owned the bottle, they keep it at the new lower price.
- The 19 card and the Imp's Trick (cards under it) are never taken during play; they stay in the middle.

## Scoring (end of hand)
- Each player scores the **sum of coins on cards in their won tricks**.
- The player holding the Bottle Imp at hand end instead scores the **negative** of the sum of coins in the Imp's Trick (the face-down discards), and **ignores their own won-trick coins**.
- Match: two modes, host picks in the lobby before starting.
  - **Target** (default): play hands until a player's running total reaches
    the target (default 100, range 10-1000); that player wins.
  - **Best of N**: play exactly N hands (range 1-20); the highest running
    total wins (ties → first in seat order).
  Totals persist across hands and survive reconnects. Implemented in
  `server/handlers.ts` (room.scores + matchMode/matchTarget/matchHands/
  handsPlayed/matchWinnerId); the engine itself stays single-hand.

## Bot behavior
- Bots must always play **legal** cards (follow suit if possible).
- Difficulty tiers are heuristics (easy random, medium follow-suit low, hard
  coin-aware value model, expert Monte Carlo rollout over hidden cards); the
  ordering is verified by a head-to-head simulation in `test/bot.test.ts`.
