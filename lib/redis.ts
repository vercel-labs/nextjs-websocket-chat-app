import Redis from "ioredis";

/**
 * Upstash Redis (TCP) client.
 *
 * Connects over the native Redis protocol using the `rediss://` URL the Vercel
 * Marketplace Upstash integration injects as `REDIS_URL`. A single
 * client library serves the whole app: regular commands run on this connection,
 * and the chat hub calls `redis.duplicate()` for the dedicated connection that
 * parks on a blocking `XREAD` — a blocking read monopolizes its connection, so
 * it can't share one with writes.
 *
 * Returns `null` when no URL is configured, so the app still runs as a single
 * in-memory instance (local broadcast only, no history) before Redis exists.
 */
function createRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[chat] No Redis URL found — running local-only. Set REDIS_URL to " +
          "enable durable history and cross-instance delivery.",
      );
    }
    return null;
  }

  // TLS is implied by the `rediss://` scheme. `maxRetriesPerRequest: null` keeps
  // a long-lived blocking read from being failed by the per-command retry cap;
  // the hub re-issues XREAD from the saved cursor on error instead.
  return new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export const redis = createRedis();

/**
 * Turn ioredis's flat stream-entry field array (`[field, val, field, val, …]`)
 * into a `{ field: val }` record.
 */
export function fieldsToObject(flat: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}
