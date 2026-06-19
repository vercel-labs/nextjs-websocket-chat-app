import type { WebSocket } from "ws";
import type Redis from "ioredis";
import { fieldsToObject, redis } from "./redis";

/**
 * Chat hub — coordinates one global room across Vercel Function instances.
 *
 * A WebSocket connection is pinned to a single instance, so cross-instance
 * delivery works by broadcasting locally now and fanning out through Redis.
 * One ioredis client (see ./redis) serves the app; the hub uses a duplicated
 * connection that blocks on XREAD to receive entries in realtime, because a
 * blocking read can't share a connection with regular commands:
 *
 *   - presence → every connection is a member of a sorted set scored by "last
 *                seen". Heartbeats keep it fresh; stale members are pruned. The
 *                roster is deduped by clientId so the count is distinct users.
 *   - messages → broadcast to local sockets immediately, then XADD to a stream.
 *                Each instance parks on a blocking XREAD and fans out entries
 *                that originated elsewhere the instant they land. New clients
 *                replay recent history.
 *   - typing   → same as messages but on a separate, transient stream that is
 *                never replayed as history.
 *
 * Without a TCP Redis URL it degrades to a single in-memory instance, so the
 * example still runs before Upstash is provisioned.
 */

export type Message = {
  id: string;
  kind: "chat" | "system";
  clientId: string;
  name: string;
  text: string;
  ts: number;
};

export type User = { clientId: string; name: string };

type ServerEvent =
  | { type: "history"; messages: Message[] }
  | { type: "message"; message: Message }
  | { type: "presence"; count: number; users: User[] }
  | { type: "typing"; clientId: string; name: string };

const CONNS_KEY = "chat:conns"; // ZSET connectionId -> lastSeen ms
const META_KEY = "chat:connmeta"; // HASH connectionId -> { clientId, name }
const MSG_STREAM = "chat:messages"; // durable message log + cross-instance relay
const TYPING_STREAM = "chat:typing"; // transient typing relay

const CONN_TTL_MS = 30_000; // a connection is gone if not refreshed within this window
const HEARTBEAT_MS = 10_000; // how often we refresh our local connections
const PRESENCE_MS = 3_000; // how often we recompute + broadcast presence
const BLOCK_MS = 5_000; // XREAD BLOCK timeout — wakes the loop to observe shutdown
const MSG_MAXLEN = 200; // cap the message stream
const TYPING_MAXLEN = 50; // cap the typing stream
const HISTORY = 50; // messages replayed to a newly-joined client

type ConnMeta = { clientId: string; name: string };
type Conn = { connectionId: string; clientId: string; name: string };
type StreamFields = { d: string; o: string };

type Hub = {
  instanceId: string;
  conns: Map<WebSocket, Conn>;
  lastMsgId: string;
  lastTypingId: string;
  heartbeat: ReturnType<typeof setInterval> | null;
  presence: ReturnType<typeof setInterval> | null;
  streamClient: Redis | null; // TCP client running the blocking read loop
  streaming: boolean; // is the read loop currently active?
  lastPresence: string; // serialized last-broadcast presence, for change detection
};

// Persist the hub across dev HMR reloads so we don't leak timers / sockets.
const globalForHub = globalThis as unknown as { __chatHub?: Hub };

const hub: Hub =
  globalForHub.__chatHub ??
  (globalForHub.__chatHub = {
    instanceId: crypto.randomUUID(),
    conns: new Map<WebSocket, Conn>(),
    lastMsgId: "0-0",
    lastTypingId: "0-0",
    heartbeat: null,
    presence: null,
    streamClient: null,
    streaming: false,
    lastPresence: "",
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Defensive JSON parse: stream payloads arrive as strings, but tolerate objects. */
function parseJson<T>(value: unknown): T | null {
  try {
    const obj = typeof value === "string" ? JSON.parse(value) : value;
    return obj && typeof obj === "object" ? (obj as T) : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, event: ServerEvent): void {
  // 1 === WebSocket.OPEN
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // best-effort; a failed send surfaces as a 'close' event
  }
}

function broadcast(event: ServerEvent): void {
  for (const ws of hub.conns.keys()) send(ws, event);
}

/** Mark a connection as recently seen (presence + metadata). */
async function touch(conn: Conn): Promise<void> {
  if (!redis || !conn.clientId) return;
  try {
    await redis.zadd(CONNS_KEY, Date.now(), conn.connectionId);
    await redis.hset(
      META_KEY,
      conn.connectionId,
      JSON.stringify({
        clientId: conn.clientId,
        name: conn.name,
      } satisfies ConnMeta),
    );
  } catch (err) {
    console.error("[chat] touch failed", err);
  }
}

/** Compute the current distinct-user roster and count. */
async function computePresence(): Promise<{ count: number; users: User[] }> {
  const seen = new Map<string, User>();

  if (!redis) {
    for (const conn of hub.conns.values()) {
      if (conn.clientId)
        seen.set(conn.clientId, { clientId: conn.clientId, name: conn.name });
    }
    return { count: seen.size, users: [...seen.values()] };
  }

  try {
    // Prune connections we haven't heard from within the TTL (members + metadata).
    const cutoff = Date.now() - CONN_TTL_MS;
    const stale = await redis.zrangebyscore(CONNS_KEY, "-inf", cutoff);
    if (stale.length) {
      await redis.zrem(CONNS_KEY, ...stale);
      await redis.hdel(META_KEY, ...stale);
    }

    const members = await redis.zrange(CONNS_KEY, 0, -1);
    if (members.length === 0) return { count: 0, users: [] };

    const meta = await redis.hmget(META_KEY, ...members);
    for (const raw of meta) {
      const entry = parseJson<ConnMeta>(raw);
      if (entry?.clientId) {
        seen.set(entry.clientId, {
          clientId: entry.clientId,
          name: entry.name,
        });
      }
    }
    return { count: seen.size, users: [...seen.values()] };
  } catch (err) {
    console.error("[chat] computePresence failed", err);
    return { count: seen.size, users: [...seen.values()] };
  }
}

/** Is a given clientId currently connected anywhere (this instance or another)? */
async function isOnline(clientId: string): Promise<boolean> {
  if (!redis) {
    for (const conn of hub.conns.values()) {
      if (conn.clientId === clientId) return true;
    }
    return false;
  }
  try {
    const members = await redis.zrange(CONNS_KEY, 0, -1);
    if (members.length === 0) return false;
    const meta = await redis.hmget(META_KEY, ...members);
    for (const raw of meta) {
      if (parseJson<ConnMeta>(raw)?.clientId === clientId) return true;
    }
    return false;
  } catch (err) {
    console.error("[chat] isOnline failed", err);
    return false;
  }
}

/** Recompute presence and broadcast it when it changed (or when forced). */
async function broadcastPresence(force = false): Promise<void> {
  const { count, users } = await computePresence();
  const snapshot = JSON.stringify({ count, users });
  if (force || snapshot !== hub.lastPresence) {
    hub.lastPresence = snapshot;
    broadcast({ type: "presence", count, users });
  }
}

/**
 * Blocking read loop: park on the message + typing streams over the TCP client
 * and fan out new entries the instant they arrive. Replaces the old ~1.5s
 * polling drain. Runs while `hub.streaming` is true (i.e. while any socket is
 * connected); `BLOCK_MS` bounds each block so the loop wakes to observe a
 * shutdown even when no traffic is flowing.
 */
async function runReadLoop(): Promise<void> {
  const client = hub.streamClient;
  if (!client) return;

  while (hub.streaming) {
    try {
      const res = (await client.xread(
        "BLOCK",
        BLOCK_MS,
        "STREAMS",
        MSG_STREAM,
        TYPING_STREAM,
        hub.lastMsgId,
        hub.lastTypingId,
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!res) continue; // BLOCK timed out with no new entries

      for (const [key, entries] of res) {
        for (const [id, flat] of entries) {
          const fields = fieldsToObject(flat) as StreamFields;
          if (key === MSG_STREAM) {
            hub.lastMsgId = id;
            if (fields.o === hub.instanceId) continue; // our own — already delivered
            const message = parseJson<Message>(fields.d);
            if (message) broadcast({ type: "message", message });
          } else if (key === TYPING_STREAM) {
            hub.lastTypingId = id;
            if (fields.o === hub.instanceId) continue;
            const typing = parseJson<User>(fields.d);
            if (typing) {
              broadcast({
                type: "typing",
                clientId: typing.clientId,
                name: typing.name,
              });
            }
          }
        }
      }
    } catch (err) {
      if (!hub.streaming) break;
      console.error("[chat] read loop failed", err);
      await sleep(1_000); // brief backoff; ioredis reconnects the socket under us
    }
  }
}

async function heartbeat(): Promise<void> {
  if (!redis) return;
  for (const conn of hub.conns.values()) await touch(conn);
}

/**
 * Start the presence/heartbeat timers and the realtime read loop on the first
 * connection. Fire-and-forget from the (synchronous) `register`, so a `join`
 * frame sent immediately on open is never blocked behind this setup.
 */
async function startStream(): Promise<void> {
  if (!hub.heartbeat)
    hub.heartbeat = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  if (!hub.presence)
    hub.presence = setInterval(() => void broadcastPresence(), PRESENCE_MS);

  if (hub.streaming) return; // reader already running
  if (!redis) return; // no Redis — single-instance fallback (timers still run)

  // A blocking XREAD monopolizes its connection, so the reader runs on its own
  // duplicated connection rather than the shared command client. Claim it
  // synchronously (no await before this) so a second concurrent register() bails
  // at the `hub.streaming` guard above instead of opening a duplicate.
  hub.streamClient = redis.duplicate();
  hub.streaming = true;

  // Start the stream cursors at the current tail so we only pick up new entries.
  for (const [key, field] of [
    [MSG_STREAM, "lastMsgId"],
    [TYPING_STREAM, "lastTypingId"],
  ] as const) {
    try {
      const tail = await redis.xrevrange(key, "+", "-", "COUNT", 1);
      hub[field] = tail[0]?.[0] ?? "0-0";
    } catch {
      hub[field] = "0-0";
    }
  }

  void runReadLoop();
}

/** Stop the read loop and timers once the last local connection goes away. */
function stopStream(): void {
  hub.streaming = false;
  if (hub.streamClient) {
    void hub.streamClient.quit().catch(() => {});
    hub.streamClient = null;
  }
  if (hub.heartbeat) {
    clearInterval(hub.heartbeat);
    hub.heartbeat = null;
  }
  if (hub.presence) {
    clearInterval(hub.presence);
    hub.presence = null;
  }
}

const clamp = (value: unknown, max: number, fallback = "") =>
  String(value ?? fallback)
    .slice(0, max)
    .trim();

/**
 * Register a freshly-connected socket (identity arrives later via join).
 *
 * Synchronous on purpose: the upgrade handler must add the connection and
 * attach its socket listeners in the same tick, before any `await`, so a
 * `join` frame the client sends immediately on open isn't dropped. The timer
 * setup runs fire-and-forget (it does its own error handling).
 */
export function register(ws: WebSocket): void {
  hub.conns.set(ws, {
    connectionId: crypto.randomUUID(),
    clientId: "",
    name: "",
  });
  void startStream();
}

/** Record the client's identity, replay history, and announce presence. */
export async function join(
  ws: WebSocket,
  clientId: string,
  name: string,
): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn) return;
  const cid = clamp(clientId, 64) || crypto.randomUUID();
  const nm = clamp(name, 40) || "anon";
  // Only announce if this user isn't already connected elsewhere (other tab or
  // instance), so reconnects/extra tabs don't spam "joined".
  const alreadyOnline = await isOnline(cid);
  conn.clientId = cid;
  conn.name = nm;
  await touch(conn);
  send(ws, { type: "history", messages: await loadHistory() });
  await broadcastPresence(true);
  if (!alreadyOnline) await postSystem(`${nm} joined`);
}

/** Publish a chat message: deliver locally now, persist + fan out via the stream. */
export async function postMessage(ws: WebSocket, text: string): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.clientId) return;
  const clean = clamp(text, 2000);
  if (!clean) return;
  const message: Message = {
    id: crypto.randomUUID(),
    kind: "chat",
    clientId: conn.clientId,
    name: conn.name,
    text: clean,
    ts: Date.now(),
  };
  await publishMessage(message);
}

/** Publish a system notice (e.g. "X joined") to everyone, including history. */
async function postSystem(text: string): Promise<void> {
  await publishMessage({
    id: crypto.randomUUID(),
    kind: "system",
    clientId: "",
    name: "system",
    text,
    ts: Date.now(),
  });
}

/** Deliver a message to local sockets now, then persist + fan out via the stream. */
async function publishMessage(message: Message): Promise<void> {
  broadcast({ type: "message", message });
  if (!redis) return;
  try {
    await redis.xadd(
      MSG_STREAM,
      "MAXLEN",
      "~",
      MSG_MAXLEN,
      "*",
      "d",
      JSON.stringify(message),
      "o",
      hub.instanceId,
    );
  } catch (err) {
    console.error("[chat] message xadd failed", err);
  }
}

/** Relay a transient "typing" signal locally and to other instances. */
export async function postTyping(ws: WebSocket): Promise<void> {
  const conn = hub.conns.get(ws);
  if (!conn?.clientId) return;
  const payload: User = { clientId: conn.clientId, name: conn.name };
  broadcast({ type: "typing", clientId: payload.clientId, name: payload.name });
  if (!redis) return;
  try {
    await redis.xadd(
      TYPING_STREAM,
      "MAXLEN",
      "~",
      TYPING_MAXLEN,
      "*",
      "d",
      JSON.stringify(payload),
      "o",
      hub.instanceId,
    );
  } catch (err) {
    console.error("[chat] typing xadd failed", err);
  }
}

/** Remove a closed socket and announce the updated presence. */
export async function unregister(ws: WebSocket): Promise<void> {
  const conn = hub.conns.get(ws);
  hub.conns.delete(ws);
  if (redis && conn?.connectionId) {
    try {
      await redis.zrem(CONNS_KEY, conn.connectionId);
      await redis.hdel(META_KEY, conn.connectionId);
    } catch (err) {
      console.error("[chat] unregister cleanup failed", err);
    }
  }
  await broadcastPresence(true);
  // Announce a leave only once this user has no remaining connections anywhere.
  if (conn?.clientId && !(await isOnline(conn.clientId))) {
    await postSystem(`${conn.name} left`);
  }
  if (hub.conns.size === 0) stopStream();
}

/** Load the most recent messages in chronological order for a new client. */
export async function loadHistory(): Promise<Message[]> {
  if (!redis) return [];
  try {
    // xrevrange returns newest-first; reverse to chronological order.
    const res = await redis.xrevrange(MSG_STREAM, "+", "-", "COUNT", HISTORY);
    return res
      .reverse()
      .map(([, flat]) => parseJson<Message>(fieldsToObject(flat).d))
      .filter((m): m is Message => m !== null);
  } catch (err) {
    console.error("[chat] loadHistory failed", err);
    return [];
  }
}
