# Sector8

Sector8 is a browser strategy board game with AI, local play, and room-based online play.

## Local run

```bash
npm start
```

Account data, rating, exp, friends, and match history are saved locally in `data/sector8.sqlite`.
Supabase settings are not required.

Open `http://localhost:8787/`.

## Local data backend

The account backend uses the local SQLite file below:

- `data/sector8.sqlite`

Keep this file when you want to preserve accounts and match history. Delete it only when you intentionally want to reset local account data.

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
