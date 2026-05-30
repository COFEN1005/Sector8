# Sector8

Sector8 is a browser strategy board game with AI, local play, and room-based online play.

## Local run

```bash
npm start
```

`supabase.local.json` or the matching environment variables must be set before the server will start.

Open `http://localhost:8787/`.

## Supabase backend

Set these values in `supabase.local.json` or environment variables to connect the app to Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`supabase.local.json` is ignored by Git, so keep your real project URL and service role key there.

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
