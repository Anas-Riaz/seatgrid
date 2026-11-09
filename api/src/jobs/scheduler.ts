import { config } from "../config.js";
import { leaderLease } from "../redis/leaderLease.js";
import * as inventoryCache from "../redis/inventoryCache.js";
import { redis } from "../redis/redis.js";
import { countAvailableSeats } from "../services/availability.js";
import { allEventIds } from "../services/catalog.js";
import { monitorShards } from "./failover.js";
import { expireHolds } from "./holdExpiry.js";
import { recoverTransactions } from "./txRecovery.js";

/** Rebuild every availability counter from the databases (corrects any drift). */
async function reconcileCounters(): Promise<void> {
  const counts = await countAvailableSeats(await allEventIds());
  await inventoryCache.setAvailable(counts, { overwrite: true });
}

/**
 * After Redis (re)connects its contents may be stale — missing, or restored from
 * an old snapshot — so counters are rebuilt and seat maps dropped (they rebuild
 * themselves from the database on the next read).
 */
let cacheNeedsRebuild = false;
redis.on("ready", () => {
  cacheNeedsRebuild = true;
});

async function rebuildCacheIfNeeded(): Promise<void> {
  if (!cacheNeedsRebuild) return;
  cacheNeedsRebuild = false;
  await inventoryCache.dropSeatMaps();
  await reconcileCounters();
  console.log("[cache] Redis (re)connected: counters rebuilt, seat maps dropped");
}

/**
 * Runs `job` every `intervalMs`, but only on the coordinator holding the leader
 * lease, and never two runs of the same job at once.
 */
function every(intervalMs: number, name: string, job: () => Promise<void>): void {
  let running = false;
  setInterval(async () => {
    if (!leaderLease.isLeader || running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      console.warn(`[job ${name}] ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs).unref();
}

export function startBackgroundJobs(): void {
  leaderLease.start();
  every(config.jobs.healthCheckEveryMs, "failover", monitorShards);
  every(config.jobs.holdExpiryEveryMs, "hold-expiry", expireHolds);
  every(config.jobs.txRecoveryEveryMs, "2pc-recovery", recoverTransactions);
  every(config.jobs.counterReconcileEveryMs, "reconcile-counters", reconcileCounters);
  every(1_000, "rebuild-cache", rebuildCacheIfNeeded);
}
