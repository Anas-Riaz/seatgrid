import * as inventoryCache from "../redis/inventoryCache.js";
import { allTicketClasses } from "./catalog.js";
import { scatter } from "./scatterGather.js";

export interface ClassAvailability {
  eventId: number;
  classId: number;
  available: number;
}

/**
 * Count AVAILABLE seats per (event, class) straight from the shard primaries.
 * Seats of one event are spread over every shard (Ring A), so each shard returns
 * partial counts and the coordinator adds them up (partial aggregation).
 * Pairs with no free seats are returned with 0.
 */
export async function countAvailableSeats(eventIds: number[]): Promise<ClassAvailability[]> {
  const partials = await scatter((shard) =>
    shard.primary.query<{ event_id: number; class_id: number; available: number }>(
      `SELECT event_id, class_id, count(*) AS available
       FROM seats WHERE status = 'AVAILABLE' AND event_id = ANY($1)
       GROUP BY event_id, class_id`,
      [eventIds],
    ),
  );

  const totals = new Map<string, number>();
  for (const p of partials.flat()) {
    const key = `${p.event_id}:${p.class_id}`;
    totals.set(key, (totals.get(key) ?? 0) + p.available);
  }

  return eventIds.flatMap((eventId) =>
    allTicketClasses().map(({ classId }) => ({
      eventId,
      classId,
      available: totals.get(`${eventId}:${classId}`) ?? 0,
    })),
  );
}

/**
 * Remaining seats per event. Served from Redis counters; events missing from
 * Redis are counted from the databases once and cached.
 */
export async function availableByEvent(eventIds: number[]): Promise<Map<number, number>> {
  const pairs = eventIds.flatMap((eventId) => allTicketClasses().map(({ classId }) => ({ eventId, classId })));
  const cached = await inventoryCache.getAvailable(pairs);

  const counts: ClassAvailability[] = pairs.map((pair, i) => ({ ...pair, available: cached[i] ?? 0 }));
  const missingEventIds = [...new Set(pairs.filter((_, i) => cached[i] === null).map((p) => p.eventId))];

  if (missingEventIds.length > 0) {
    const fresh = await countAvailableSeats(missingEventIds);
    await inventoryCache.setAvailable(fresh, { overwrite: false });
    for (const f of fresh) {
      counts.find((c) => c.eventId === f.eventId && c.classId === f.classId)!.available = f.available;
    }
  }

  const byEvent = new Map<number, number>(eventIds.map((id) => [id, 0]));
  for (const c of counts) byEvent.set(c.eventId, byEvent.get(c.eventId)! + c.available);
  return byEvent;
}
