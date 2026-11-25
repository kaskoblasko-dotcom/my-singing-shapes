# My Singing Shapes: Server

This server hosts the game and stores player accounts, cloud saves and friends data in Postgres.

## What's inside

| File | What it is |
|---|---|
| `server.js` | The game server. It uses only Node built-ins plus `pg`. |
| `public/index.html` | The game itself, served at `/`. |
| `package.json` | Start script and the `pg` dependency. |
| `render.yaml` | Render Blueprint that creates the web service and a Postgres database. |

## Deploy on Render

### Option A: Blueprint (easiest)

1. Push this folder to a GitHub repo.
2. In Render, go to **New → Blueprint** and pick the repo.
3. Render reads `render.yaml`, creates the `my-singing-shapes` web service and the `my-singing-shapes-db` Postgres database, and links them through `DATABASE_URL`.
4. Open the service URL. That's the game.

### Option B: by hand

1. Create a **PostgreSQL** database on Render.
2. Create a **Web Service** from your repo with these settings:
   - Build command: `npm install`
   - Start command: `npm start`
3. In the web service's **Environment**, add `DATABASE_URL` and set it to the database's **Internal Database URL**.

The tables are created automatically the first time the server starts.

## Run locally

```
npm install
npm start
```

Then open http://localhost:3000.

- Without `DATABASE_URL`, the server uses an in-memory store. It's handy for testing, but the data is lost when the server stops.
- To use a real database locally, set `DATABASE_URL=postgres://...` first.

## Updating the game

Replace `public/index.html` with the new `my-singing-shapes.html` and redeploy.

## API

All requests and responses are JSON. Logged-in requests send `Authorization: Bearer <token>`.

| Method and path | What it does |
|---|---|
| `POST /api/signup` `{username, password}` | Creates an account. Returns `{token, user}`. |
| `POST /api/login` `{username, password}` | Returns `{token, user, save, likes}`. |
| `POST /api/logout` | Ends the session. |
| `GET /api/me` | Returns `{user, save, likes}`. |
| `POST /api/save` `{data}` | Stores the player's save. The game sends this automatically about every 12 seconds and when the page closes. |
| `GET /api/friends` | Returns `{me, friends, incoming, outgoing, gifts, giftedToday, likes}`. |
| `POST /api/friends/request` `{query}` | Sends a request by username or friend code. If that player already asked you, you become friends straight away. |
| `POST /api/friends/respond` `{id, accept}` | Accepts or declines a request. |
| `POST /api/friends/cancel` `{id}` | Cancels a request you sent. |
| `POST /api/friends/remove` `{id}` | Removes a friend. |
| `GET /api/visit?id=` | Returns a friend's save, likes and which islands you've liked. |
| `POST /api/like` `{id, island}` | Likes one of a friend's islands. Each island can be liked once per friend. |
| `POST /api/gift` `{id, kind}` | Sends a gift: `coins` (1,000) or `food` (200). One gift per friend per day. |
| `POST /api/gifts/claim` `{id}` | Claims a received gift. |

## Account rules

- **Usernames:** 3–16 characters, using lowercase letters, numbers or `_`.
- **Passwords:** at least 6 characters, stored with scrypt and a per-user salt.
- **Rate limits:** sign-up and login attempts are limited per IP address.
