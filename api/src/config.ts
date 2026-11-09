import os from "node:os";

const text = (name: string, fallback: string) => process.env[name] ?? fallback;
const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const config = {
  port: number("PORT", 4000),
  /** Container hostname: shows which coordinator served a request. */
  coordinatorId: os.hostname(),

  metaDatabaseUrl: text("META_DATABASE_URL", "postgres://postgres:postgres@localhost:5432/meta"),
  shardDatabase: {
    user: text("SHARD_DB_USER", "postgres"),
    password: text("SHARD_DB_PASSWORD", "postgres"),
    database: "seatgrid",
  },
  redisUrl: text("REDIS_URL", "redis://localhost:6379"),
  authSecret: text("AUTH_SECRET", "change-me-in-production"),

  /** Positions per shard on each consistent-hash ring. */
  virtualNodes: 128,

  /** Per-node connection pool, bulkhead and circuit breaker. */
  node: {
    poolSize: number("NODE_POOL_SIZE", 10),
    connectTimeoutMs: 3_000,
    statementTimeoutMs: 5_000,
    queueWaitMs: 1_000,
    /** Reads may queue deeper than writes: past the write limit, bookings are shed (503) but search keeps working. */
    readQueueLimit: number("READ_QUEUE_LIMIT", 100),
    writeQueueLimit: number("WRITE_QUEUE_LIMIT", 20),
    breakerFailureThreshold: 3,
    breakerOpenMs: 10_000,
  },

  /** Requests one coordinator works on at once; writes are shed before reads. */
  admission: {
    maxInFlight: number("MAX_IN_FLIGHT", 64),
    maxInFlightForWrites: number("MAX_IN_FLIGHT_WRITES", 24),
  },

  /** Search results are cached briefly in Redis (cache-aside). */
  searchCacheSeconds: 2,

  holds: {
    ttlSeconds: number("HOLD_TTL_SECONDS", 300),
    maxSeats: 6,
  },

  wallet: { openingBalance: 100_000 },

  rateLimit: {
    perIp: { ratePerSecond: number("RATE_LIMIT_IP_PER_SEC", 2_000), burst: number("RATE_LIMIT_IP_BURST", 4_000) },
    perUser: { ratePerSecond: number("RATE_LIMIT_USER_PER_SEC", 10), burst: number("RATE_LIMIT_USER_BURST", 20) },
  },

  /** Background jobs run only on the coordinator holding the Redis lease. */
  lease: { ttlMs: 5_000, renewEveryMs: 1_500 },
  jobs: {
    healthCheckEveryMs: 1_000,
    /** A primary must be definitely down for this many checks AND this long before failover. */
    failedChecksBeforeFailover: 3,
    minDownMsBeforeFailover: 5_000,
    holdExpiryEveryMs: 5_000,
    txRecoveryEveryMs: 5_000,
    /** A prepared transaction this old with no decision is treated as orphaned. */
    txOrphanAfterSeconds: 15,
    counterReconcileEveryMs: 60_000,
  },

  /** Lets a request kill its coordinator mid-2PC to demonstrate recovery. Dev only. */
  crashInjection: text("CRASH_INJECTION", "off") === "on",

  seed: {
    shardCount: number("SHARD_COUNT", 3),
    users: number("SEED_USERS", 1_000_000),
    events: number("SEED_EVENTS", 100),
    seatsPerSection: number("SEATS_PER_SECTION", 1_000),
  },
};
