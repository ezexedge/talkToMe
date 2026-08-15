# TalkToMe

Audio-only 1-to-1 calls for language practice. Browsers talk directly over
WebRTC; the server only handles signaling.

## Stack

| Layer | Tech |
|---|---|
| Monorepo | Turborepo + npm workspaces |
| Frontend | React 19, Vite, MUI, React Router |
| Backend | NestJS 10 |
| Auth | Auth0 (Google sign-in, RS256 JWT) |
| Database | PostgreSQL (Neon) + TypeORM |
| Cache / messaging | Redis (Upstash) — Pub/Sub + room state |
| Realtime | Server-Sent Events (browser ← server), HTTP POST (browser → server) |
| Media | WebRTC (peer-to-peer audio, STUN) |
| Deploy | Docker Compose + Nginx (API), Vercel (frontend) |

## How a call works

```
   Browser A                  API (NestJS)                  Browser B
       │                           │                            │
       │──── POST /offer ─────────►│                            │
       │                           │── PUBLISH ─► Redis ──┐     │
       │                           │                      ▼     │
       │                           │◄──────────── (other instance)
       │                           │──────── SSE: offer ───────►│
       │                           │                            │
       │◄─────── SSE: answer ──────│◄────── POST /answer ───────│
       │                           │                            │
       │◄════════ WebRTC audio — direct, never touches the server ═══════►│
```

Signaling (offer / answer / ICE) goes through the API. Audio does not: once
peers are introduced, they connect directly.

Redis Pub/Sub is what lets the two users sit on **different API instances** —
room membership and per-user state live in Redis, so any instance can serve any
client.

## Layout

```
apps/
  front/   React client      → Vercel
  api/     NestJS signaling  → Docker + Nginx (3 replicas)
deploy/
  nginx.conf                 reverse proxy, SSE-aware
```

## Running locally

```bash
npm install
npm run dev            # front on :3001, api on :3000
```

Both apps need a `.env` (not versioned) with Auth0, Neon and Upstash
credentials.

> `getUserMedia` requires HTTPS or `localhost`.

## Notes

- The `clientId` in a room is the Auth0 `sub`, derived server-side from the
  verified token — never sent by the client.
- One user, one room, one seat.
- SSE carries the token as a query param because `EventSource` cannot send
  headers.
