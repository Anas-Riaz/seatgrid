import { cluster } from "../cluster/cluster.js";
import * as inventoryCache from "../redis/inventoryCache.js";

/**
 * Releases holds whose time is up, so an abandoned checkout cannot lock seats
 * forever, and gives the seats back to the Redis counters and seat maps.
 */
export async function expireHolds(): Promise<void> {
  for (const shard of cluster.all()) {
    try {
      const expired = await shard.primary.query<{ event_id: number; section_id: number; class_id: number; seat_no: number }>(
        `UPDATE seats SET status = 'AVAILABLE', hold_id = NULL, held_by = NULL, held_until = NULL
         WHERE status = 'HELD' AND held_until < now()
         RETURNING event_id, section_id, class_id, seat_no`,
        [],
        "write",
      );
      if (expired.length === 0) continue;

      const groups = new Map<string, { eventId: number; sectionId: number; classId: number; seatNos: number[] }>();
      for (const seat of expired) {
        const key = `${seat.event_id}:${seat.section_id}`;
        if (!groups.has(key)) {
          groups.set(key, { eventId: seat.event_id, sectionId: seat.section_id, classId: seat.class_id, seatNos: [] });
        }
        groups.get(key)!.seatNos.push(seat.seat_no);
      }
      for (const group of groups.values()) await inventoryCache.release(group);

      console.log(`[holds] shard ${shard.id}: released ${expired.length} expired seats`);
    } catch (err) {
      console.warn(`[holds] shard ${shard.id}: ${(err as Error).message}`);
    }
  }
}
