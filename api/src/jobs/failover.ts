import pg from "pg";
import { cluster, type ShardMapRow } from "../cluster/cluster.js";
import { meta } from "../cluster/meta.js";
import { config } from "../config.js";
import { isDefinitelyDown } from "../errors.js";

/**
 * Health monitor and failover manager (runs on the lease holder only).
 *
 * Every second each shard primary is probed. When a primary has been DOWN for
 * several checks in a row (and for a minimum time):
 *   1. promote its replica with pg_promote()
 *   2. publish a new shard-map version (replica becomes primary, old primary is fenced)
 *   3. every coordinator picks up the new map within a second and switches writes
 * Meanwhile only that shard's writes fail (fast, via its circuit breaker); other shards are unaffected.
 *
 * Avoiding false failovers: an overloaded node and a dead node both make probes
 * slow, but promoting a replica of a node that is merely busy loses its latest
 * (asynchronously replicated) transactions. So only definitive answers count as
 * DOWN — "host does not exist", "connection refused", "server shutting down".
 * A timeout means UNKNOWN and never triggers a failover on its own.
 */

type Health = "UP" | "DOWN" | "UNKNOWN";

/** Long enough for DNS to report a stopped container as ENOTFOUND (~3.5s in Docker). */
const PROBE_TIMEOUT_MS = 5_000;
const PROMOTE_TIMEOUT_MS = 15_000;

const downSince = new Map<number, { checks: number; since: number }>();
const fencedHosts = new Set<string>();

export async function monitorShards(): Promise<void> {
  // Probe shards in parallel so one slow node cannot delay the checks of the others.
  await Promise.all(cluster.shardMap.map(checkShard));
}

async function checkShard(row: ShardMapRow): Promise<void> {
  if (row.fenced_host) await fenceIfBack(row.fenced_host);

  const health = await probe(row.primary_host);
  if (health === "UP") {
    downSince.delete(row.shard_id);
    return;
  }
  if (health === "UNKNOWN") return; // slow is not dead: keep waiting for a clear answer

  const down = downSince.get(row.shard_id) ?? { checks: 0, since: Date.now() };
  down.checks++;
  downSince.set(row.shard_id, down);
  console.warn(`[failover] shard ${row.shard_id} primary ${row.primary_host} is DOWN (check ${down.checks})`);

  const longEnough = Date.now() - down.since >= config.jobs.minDownMsBeforeFailover;
  if (down.checks >= config.jobs.failedChecksBeforeFailover && longEnough) {
    await promoteReplica(row, down.since);
  }
}

async function promoteReplica(row: ShardMapRow, downSinceMs: number): Promise<void> {
  if (!row.replica_host) {
    console.error(`[failover] shard ${row.shard_id} has no replica to promote — its writes stay unavailable`);
    return;
  }

  // Waits (up to 10s) until the replica has finished promotion and accepts writes.
  await withConnection(row.replica_host, PROMOTE_TIMEOUT_MS, (client) => client.query("SELECT pg_promote(true, 10)"));

  const published = await meta.query(
    `UPDATE shard_map
     SET primary_host = replica_host, replica_host = NULL, fenced_host = primary_host,
         version = version + 1, updated_at = now()
     WHERE shard_id = $1 AND primary_host = $2`,
    [row.shard_id, row.primary_host],
  );
  downSince.delete(row.shard_id);
  if (published.rowCount !== 1) return; // someone else already changed the map

  await cluster.refresh();
  const seconds = ((Date.now() - downSinceMs) / 1000).toFixed(1);
  console.log(
    `[failover] shard ${row.shard_id}: promoted ${row.replica_host} to primary, fenced ${row.primary_host} (${seconds}s after it went down)`,
  );
}

/**
 * The old primary must never accept writes again (split brain). Coordinators no
 * longer route to it, and if it comes back it is switched to read-only until it
 * is rebuilt as a replica of the new primary.
 */
async function fenceIfBack(host: string): Promise<void> {
  if (fencedHosts.has(host) || (await probe(host)) !== "UP") return;
  await withConnection(host, PROBE_TIMEOUT_MS, async (client) => {
    await client.query("ALTER SYSTEM SET default_transaction_read_only = on");
    await client.query("SELECT pg_reload_conf()");
  });
  fencedHosts.add(host);
  console.log(`[failover] old primary ${host} is back and has been fenced (read-only)`);
}

async function probe(host: string): Promise<Health> {
  try {
    await withConnection(host, PROBE_TIMEOUT_MS, (client) => client.query("SELECT 1"));
    return "UP";
  } catch (err) {
    return isDefinitelyDown(err) ? "DOWN" : "UNKNOWN";
  }
}

/** A short-lived connection with its own timeouts, independent of the request pools. */
async function withConnection<T>(host: string, timeoutMs: number, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const [hostname, port = "5432"] = host.split(":");
  const client = new pg.Client({
    host: hostname,
    port: Number(port),
    user: config.shardDatabase.user,
    password: config.shardDatabase.password,
    database: config.shardDatabase.database,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
