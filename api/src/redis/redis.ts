import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Redis is a performance layer only: the databases are the source of truth.
 * Commands fail fast (no offline queue, short timeout) so a Redis outage makes
 * requests slower, never stuck.
 */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 500,
});

let lastWarning = 0;
redis.on("error", (err) => {
  if (Date.now() - lastWarning > 5_000) {
    lastWarning = Date.now();
    console.warn(`[redis] ${err.message}`);
  }
});

export const redisReady = () => redis.status === "ready";

/** Runs `fn` against Redis, or returns `fallback` if Redis is down or the call fails. */
export async function withRedis<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!redisReady()) return fallback;
  try {
    return await fn();
  } catch (err) {
    console.warn(`[redis] ${(err as Error).message}`);
    return fallback;
  }
}

/** A Lua script that runs atomically inside Redis. Sent once, then called by its SHA1. */
export function luaScript(source: string) {
  const sha = createHash("sha1").update(source).digest("hex");
  return async (keys: string[], args: (string | number)[]): Promise<unknown> => {
    try {
      return await redis.evalsha(sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (!String(err).includes("NOSCRIPT")) throw err;
      return redis.eval(source, keys.length, ...keys, ...args);
    }
  };
}
