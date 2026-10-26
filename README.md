# Sector8

Sector8 is a browser strategy board game with AI, local play, and room-based online play.

## Local run

```bash
npm start
```

Account data, rating, exp, friends, match history, and saved formations are saved to Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured.
Local development falls back to SQLite at `data/sector8.sqlite`. Production refuses to start without Supabase so online data is never silently written to an ephemeral Render disk.

Open `http://localhost:8787/`.

## Account backend

For online persistence, set these values in `supabase.local.json`, Render environment variables, or your local environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server secret; never put it in browser code or GitHub)

Run the complete contents of `supabase/schema.sql` in the Supabase SQL Editor after creating or updating a project. It is safe to run repeatedly and installs the atomic registration, login, friend, and match-finalization functions used by the server.

The formation editor stores one preset per logged-in player in `player_formations`. Sign in on another device to load it. Existing browser-only formations remain visible until explicitly saved with `SAVE FORMATION`; guests continue using browser storage. The browser never receives the Supabase service-role key.

## Level pass

The lobby's `LEVEL PASS` tab shows levels 1-50. Player level and EXP remain in `players`; claimed rewards are stored per player in `player_level_pass_unlocks`. Apply `supabase/schema.sql` before deploying. The server validates both the reward key and required level, and duplicate claims are safe. Lv5 now grants one Koh exchange ticket.

Define real rewards in `ACTIVE_REWARDS` in `level-pass.js`. Other Koh, BGM, and bonus milestones remain placeholders until defined. The Lv1 title is a persistence example only, not an equipable title yet. To extend beyond Lv50, increase `INITIAL_LEVEL_PASS_MAX` and add the new reward definitions; player levels are not capped at 50.

## Shop

`SHOP` shows the ticket balance, purchase history, and future products. The five existing Koh remain free. No new Koh has been defined yet, so the only visible product is marked `準備中` and cannot be purchased. To release a new Koh, implement its gameplay and purchase-based ability selection, then add an active entry with a unique `key`, `type: 'koh'`, `itemKey`, `currency: 'koh_ticket'`, and positive `price` to `shop-catalog.js`. Other item types can use the same purchase record. The server checks the active catalog and account session; Supabase redeems atomically through `sector8_redeem_shop_product`, while SQLite uses a transaction. The balance is claimed Koh tickets minus purchases, so duplicate Lv5 claims never mint extra tickets. Apply the updated `supabase/schema.sql` before deploying the shop.

## Tutorial

Open `TUTORIAL` from the lobby or top navigation. Its five scenes use the normal fixed-map battle engine: combat, recovery of a **friendly** military flag with Tei, information collapse with only a scout in area 2, the five playable Koh types, and a real enemy-core capture. Enemy flags cannot be picked up. Training does not update account progress, rating, or match history.

After deployment, open `/api/account/health`. A ready project returns `ok: true`, `backend: "supabase"`, and `schemaVersion: 4`. `supabase_schema_update_required` means the SQL above has not been applied yet.

Without Supabase values, local development uses `data/sector8.sqlite`. Set `ACCOUNT_BACKEND=sqlite` only when an explicit local database is desired in a production-like environment.

## Online match flow

1. Open the game URL.
2. Select `オンライン`.
3. Player 1 creates a room and shares the room ID.
4. Player 2 joins with that room ID.
5. Player 1 starts the match.

The same URL works on PC and mobile. The app detects the device and switches to a mobile-friendly layout on phones.

## Match replays

New matches record the full board at the start of each player's turn and at the final result. After the match result is saved, the replay is compressed and uploaded separately, so a replay upload failure does not undo rating or match-history updates. Open a match in history and select `REPLAY` to scrub turns, play automatically, or inspect any of the three areas. Matches played before replay recording was enabled do not have board data to replay.

## GitHub

Use `PUSH_TO_GITHUB.bat` for the normal update flow. It automatically stages changes, creates a commit with `Update Sector8` when needed, and pushes to `origin/main`.

```bash
PUSH_TO_GITHUB.bat
```

This project keeps its Git metadata in `gitstore`, so the batch file is the safest way to publish changes from this folder.

## Render

Create a new Render Web Service from `COFEN1005/Sector8`.

- Runtime: Node
- Build command: `npm install --omit=dev`
- Start command: `node server.js`

`render.yaml` is included, so Render can also create the service from the blueprint.
