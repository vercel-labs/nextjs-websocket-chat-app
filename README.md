# Realtime chat (Next.js + WebSockets on Vercel)

A single global chat room built on [WebSockets on Vercel Functions](https://vercel.com/docs/functions/websockets): live user count, typing indicators, and realtime messages, with a deterministic [boring-avatars](https://boringavatars.com/) avatar per user and the last ~50 messages replayed on join.

## How it works

- `app/api/ws/route.ts` upgrades the request to a WebSocket with `experimental_upgradeWebSocket()` from [`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#experimental_upgradewebsocket).
- `lib/chat.ts` is the hub. A connection is pinned to one Function instance, so it broadcasts to local sockets immediately and fans out across instances through Redis. A single [ioredis](https://github.com/redis/ioredis) client handles writes and presence; a duplicated connection runs a blocking `XREAD` to receive other instances' messages in realtime.
- Redis keys: `chat:conns` + `chat:connmeta` (presence, deduped by `clientId`), `chat:messages` (durable log + history), `chat:typing` (transient relay).
- `app/components/ChatRoom.tsx` owns per-tab identity (`crypto.randomUUID()` + name in `sessionStorage`); `Chat.tsx` opens the socket, renders the room, and reconnects with backoff.

Redis is optional: without `REDIS_URL` the app runs as a single in-memory instance (no history, no cross-instance delivery).

## Run locally

WebSocket upgrades need the Vercel runtime, so start the app with the Vercel CLI:

```bash
vercel dev
```

Open [http://localhost:3000](http://localhost:3000) in two tabs (each tab is a distinct user). `pnpm dev:next` runs plain `next dev` for UI work, but the WebSocket route won't function there.

## Redis

Add [Upstash Redis](https://vercel.com/marketplace/redis) from the Vercel Marketplace, then pull the credentials:

```bash
vercel env pull .env.local
```

This sets `REDIS_URL` — the connection string the ioredis client uses.

## Deploy

Deploy to [Vercel](https://vercel.com/new). WebSockets require [Fluid Compute](https://vercel.com/docs/fluid-compute), the default for projects created on or after April 23, 2025.
