# Sector8

Sector8 is a browser strategy board game with AI, local play, and room-based online play.

## Local run

```bash
npm start
```

Open `http://localhost:8787/`.

## Online match flow

1. Open the game URL.
2. Select `オンライン`.
3. Player 1 creates a room and shares the room ID.
4. Player 2 joins with that room ID.
5. Player 1 starts the match.

The same URL works on PC and mobile. The app detects the device and switches to a mobile-friendly layout on phones.

## GitHub

```bash
git init
git add .
git commit -m "Add online multiplayer and responsive UI"
git branch -M main
git remote add origin https://github.com/COFEN1005/Sector8.git
git push -u origin main
```

If the GitHub repository already has files, run `git pull origin main --allow-unrelated-histories` before pushing, resolve any conflicts, then push again.

## Render

Create a new Render Web Service from `COFEN1005/Sector8`.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

`render.yaml` is included, so Render can also create the service from the blueprint.
