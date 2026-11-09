import { createHash } from "node:crypto";

/** Position on the ring: the first 32 bits of the key's MD5 digest. */
export function hash32(key: string): number {
  return createHash("md5").update(key).digest().readUInt32BE(0);
}

interface RingPoint {
  position: number;
  shardId: number;
}

/**
 * Consistent-hash ring with virtual nodes.
 *
 * Each shard is placed at `virtualNodes` pseudo-random positions. A key belongs to
 * the first position clockwise from the key's own hash. Adding a shard therefore
 * moves only about 1/(N+1) of the keys, and every coordinator that builds a ring
 * from the same shard list gets exactly the same routing — no coordination needed.
 */
export class HashRing {
  private readonly points: RingPoint[];

  /** @param name distinguishes rings (A, B) so they place shards at different positions. */
  constructor(readonly name: string, shardIds: number[], virtualNodes: number) {
    if (shardIds.length === 0) throw new Error(`Ring ${name} needs at least one shard`);

    this.points = shardIds
      .flatMap((shardId) =>
        Array.from({ length: virtualNodes }, (_, i) => ({
          position: hash32(`${name}:shard-${shardId}:vnode-${i}`),
          shardId,
        })),
      )
      .sort((a, b) => a.position - b.position);
  }

  /** Binary search for the first point at or after the key's hash (wrapping to the start). */
  shardFor(key: string): number {
    const target = hash32(key);
    let low = 0;
    let high = this.points.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.points[mid].position < target) low = mid + 1;
      else high = mid;
    }
    return this.points[low % this.points.length].shardId;
  }
}

/** Ring A key: seat inventory is placed by (event, section), so one hot match spreads over all shards. */
export const sectionKey = (eventId: number, sectionId: number) => `event-${eventId}:section-${sectionId}`;

/** Ring B key: accounts are placed by username. */
export const userKey = (username: string) => `user-${username}`;
