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

After deployment, open `/api/account/health`. A ready project returns `ok: true`, `backend: "supabase"`, and `schemaVersion: 3`. `supabase_schema_update_required` means the SQL above has not been applied yet.

Without Supabase values, local development uses `data/sector8.sqlite`. Set `ACCOUNT_BACKEND=sqlite` only when an explicit local database is desired in a production-like environment.

## Online match flow

1. Open the game URL.
2. Select `オンライン`.
3. Player 1 creates a room and shares the room ID.
4. Player 2 joins with that room ID.
5. Player 1 starts the match.

The same URL works on PC and mobile. The app detects the device and switches to a mobile-friendly layout on phones.

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
