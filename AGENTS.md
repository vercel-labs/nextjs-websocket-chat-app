<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Project: realtime chat over Vercel WebSockets

A single global chat room: live user count, typing indicators, realtime
messages, and a boring-avatars avatar per user. Built on Next.js 16 (App Router)
and WebSockets on Vercel Functions, with cross-instance state in Upstash Redis.

## Architecture

- `app/api/ws/route.ts` — upgrades the request with
  `experimental_upgradeWebSocket()` from `@vercel/functions` and dispatches
  `join` / `message` / `typing` frames. Listeners are attached synchronously
  (no `await` before `ws.on('message')`) so a `join` sent immediately on open is
  never dropped.
- `lib/chat.ts` — the hub. A connection is pinned to one Function instance, so
  delivery is: broadcast to local sockets now, then fan out through Redis. One
  ioredis client handles writes (XADD) and presence; the hub uses a duplicated
  connection (`redis.duplicate()`) to run a blocking `XREAD` on the message and
  typing streams, receiving other instances' entries in realtime. Presence is a
  sorted set (heartbeat + TTL prune) deduped by `clientId`, so the count is
  distinct users. Hub state lives on `globalThis` to survive HMR. Redis keys:
  `chat:conns`, `chat:connmeta`, `chat:messages` (durable, replayed as history),
  `chat:typing` (transient).
- `lib/redis.ts` — the single ioredis client from `REDIS_URL`, plus a
  `fieldsToObject` helper. `null` when unset, which degrades to a single
  in-memory instance (local broadcast only, no history). Keep that fallback
  intact.
- `app/components/ChatRoom.tsx` — identity (`crypto.randomUUID()` clientId +
  name) in `sessionStorage`, so each tab is its own user. `Chat.tsx` — the live
  room, with reconnect/backoff (sockets close at the Function's max duration).

## Conventions and gotchas

- A blocking `XREAD` monopolizes its connection, so the reader runs on a
  separate `redis.duplicate()` connection — never issue commands on the stream
  client. Stream entries come back as flat `[field, val, …]` arrays; parse them
  with the `fieldsToObject` helper.
- Cross-instance fan-out skips entries tagged with this instance's id (the `o`
  field), since those were already delivered to local sockets.
- Wire protocol: client sends `join` / `message` / `typing`; server sends
  `history` / `message` / `presence` / `typing`. Names clamp to 40 chars, text
  to 2000.
- Do not run the dev server — the user starts `vercel dev` / `next dev`. Plain
  `next dev` cannot serve `/api/ws` (no upgrade runtime); verify with the
  command below instead.
- This project does not use Socket.IO despite the directory name.

## Verify

    pnpm exec tsc --noEmit && pnpm exec eslint . && pnpm build
