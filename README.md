# Sector8

Sector8 is a browser strategy board game with AI, local play, and room-based online play.

## Local run

```bash
npm start
```

Account data, rating, exp, friends, and match history are saved to Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured.
If Supabase is not configured, the server falls back to local SQLite at `data/sector8.sqlite`.

Open `http://localhost:8787/`.

## Account backend

For online persistence, set these values in `supabase.local.json`, Render environment variables, or your local environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Without those values, the app uses `data/sector8.sqlite` for local testing only.

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
