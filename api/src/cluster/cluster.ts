import { config } from "../config.js";
import { DbNode } from "./dbNode.js";
import { HashRing, sectionKey, userKey } from "./hashRing.js";
import { meta } from "./meta.js";
import { Shard } from "./shard.js";

export interface ShardMapRow {
  shard_id: number;
  primary_host: string;
  replica_host: string | null;
  fenced_host: string | null;
  version: number;
}

/**
 * This coordinator's view of the cluster: the shard map (from the meta DB) and
 * the two consistent-hash rings built from it.
 *
 *   Ring A  hash(event, section) -> shard holding that section's seats and bookings
 *   Ring B  hash(username)       -> shard holding that user's account, wallet and tickets
 *
 * The map is polled every second, so a failover published by the lease holder
 * reaches every coordinator quickly. If the meta DB is down, the cached map keeps routing.
 */
class Cluster {
  private shards = new Map<number, Shard>();
  private nodes = new Map<string, DbNode>();
  private ringA!: HashRing;
  private ringB!: HashRing;
  private rows: ShardMapRow[] = [];
  private nextReadShard = 0;

  /** Sum of all row versions; grows by one with every change to the map. */
  version = 0;

  async start(): Promise<void> {
    for (;;) {
      try {
        await this.refresh();
        break;
      } catch (err) {
        console.warn(`[cluster] waiting for shard map: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    setInterval(() => {
      this.refresh().catch((err) =>
        console.warn(`[cluster] meta DB unavailable, keeping cached shard map: ${err.message}`),
      );
    }, 1_000).unref();
  }

  async refresh(): Promise<void> {
    const { rows } = await meta.query<ShardMapRow>(
      "SELECT shard_id, primary_host, replica_host, fenced_host, version FROM shard_map ORDER BY shard_id",
    );
    if (rows.length === 0) throw new Error("shard map is empty (has the seed job run?)");

    const version = rows.reduce((sum, row) => sum + row.version, 0);
    if (version !== this.version) this.apply(rows, version);
  }

  shardForSection(eventId: number, sectionId: number): Shard {
    return this.shard(this.ringA.shardFor(sectionKey(eventId, sectionId)));
  }

  shardForUser(username: string): Shard {
    return this.shard(this.ringB.shardFor(userKey(username)));
  }

  shard(id: number): Shard {
    const shard = this.shards.get(id);
    if (!shard) throw new Error(`Unknown shard ${id}`);
    return shard;
  }

  all(): Shard[] {
    return [...this.shards.values()];
  }

  /** Reference data is copied to every shard, so any shard can answer; rotate to spread load. */
  anyShard(): Shard {
    const shards = this.all();
    return shards[this.nextReadShard++ % shards.length];
  }

  get shardMap(): ShardMapRow[] {
    return this.rows;
  }

  private apply(rows: ShardMapRow[], version: number): void {
    const nodeFor = (host: string) => {
      if (!this.nodes.has(host)) this.nodes.set(host, new DbNode(host));
      return this.nodes.get(host)!;
    };

    this.shards = new Map(
      rows.map((row) => [
        row.shard_id,
        new Shard(row.shard_id, nodeFor(row.primary_host), row.replica_host ? nodeFor(row.replica_host) : null),
      ]),
    );

    // Drop connection pools to nodes that left the map (for example a fenced old primary).
    const hostsInUse = new Set(rows.flatMap((row) => [row.primary_host, row.replica_host]));
    for (const [host, node] of this.nodes) {
      if (!hostsInUse.has(host)) {
        void node.close();
        this.nodes.delete(host);
      }
    }

    const shardIds = rows.map((row) => row.shard_id);
    this.ringA = new HashRing("A", shardIds, config.virtualNodes);
    this.ringB = new HashRing("B", shardIds, config.virtualNodes);
    this.rows = rows;
    this.version = version;

    const layout = rows.map((r) => `${r.shard_id}=${r.primary_host}${r.replica_host ? `+${r.replica_host}` : ""}`);
    console.log(`[cluster] shard map v${version}: ${layout.join(", ")}`);
  }
}

export const cluster = new Cluster();
