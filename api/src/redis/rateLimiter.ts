import { luaScript, withRedis } from "./redis.js";

/**
 * Token bucket shared by all coordinators. Each key gets `burst` tokens that
 * refill at `ratePerSecond`; a request spends one. Time comes from the Redis
 * server, so coordinator clocks do not need to agree.
 *
 * KEYS: bucket.  ARGV: rate per second, burst.  Returns {allowed, retryAfterMs}.
 */
const takeTokenScript = luaScript(`
  local rate = tonumber(ARGV[1])
  local burst = tonumber(ARGV[2])
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

  local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
  local tokens = tonumber(bucket[1]) or burst
  local updated = tonumber(bucket[2]) or now
  tokens = math.min(burst, tokens + (now - updated) / 1000 * rate)

  local allowed = 0
  local retryAfterMs = 0
  if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
  else
    retryAfterMs = math.ceil((1 - tokens) / rate * 1000)
  end

  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
  redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
  return {allowed, retryAfterMs}
`);

export interface BucketLimit {
  ratePerSecond: number;
  burst: number;
}

/** Returns 0 if the request may proceed, otherwise seconds to wait. Fails open if Redis is down. */
export function takeToken(key: string, limit: BucketLimit): Promise<number> {
  return withRedis(async () => {
    const [allowed, retryAfterMs] = (await takeTokenScript([`rl:${key}`], [limit.ratePerSecond, limit.burst])) as [
      number,
      number,
    ];
    return allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000));
  }, 0);
}
