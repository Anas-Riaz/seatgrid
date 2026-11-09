import { luaScript, redis, withRedis } from "./redis.js";

/**
 * Redis view of seat inventory. It answers "sold out?" and "is this seat free?"
 * without touching PostgreSQL, so most contention never reaches the database.
 *
 *   avail:{event}:{class}            remaining seats of a ticket class (counter)
 *   seatmap:{event}:{section}        one bit per seat, 1 = held or booked
 *   hold:{event}:{section}:{seat}    hold id, expires with the hold (mirror of seats.held_until)
 *
 * Rules that keep it safe: the database always has the final say; a missing key
 * means "unknown" (never "free"); scripts never create a missing seat map, so a
 * partial bitmap can't exist; any doubt is resolved by deleting the key and
 * rebuilding it from the database.
 */

const keys = {
  available: (eventId: number, classId: number) => `avail:${eventId}:${classId}`,
  seatMap: (eventId: number, sectionId: number) => `seatmap:${eventId}:${sectionId}`,
  holdPrefix: (eventId: number, sectionId: number) => `hold:${eventId}:${sectionId}:`,
};

export type ReserveResult = "OK" | "SOLD_OUT" | "TAKEN" | "UNKNOWN";

// KEYS: counter, seat map.  ARGV: count, hold TTL ms, hold id, hold key prefix, seat numbers...
const reserveScript = luaScript(`
  local available = redis.call('GET', KEYS[1])
  if not available then return 'UNKNOWN' end
  if tonumber(available) < tonumber(ARGV[1]) then return 'SOLD_OUT' end

  local hasMap = redis.call('EXISTS', KEYS[2]) == 1
  for i = 5, #ARGV do
    if redis.call('EXISTS', ARGV[4] .. ARGV[i]) == 1 then return 'TAKEN' end
    if hasMap and redis.call('GETBIT', KEYS[2], ARGV[i]) == 1 then return 'TAKEN' end
  end

  redis.call('DECRBY', KEYS[1], ARGV[1])
  for i = 5, #ARGV do
    if hasMap then redis.call('SETBIT', KEYS[2], ARGV[i], 1) end
    redis.call('SET', ARGV[4] .. ARGV[i], ARGV[3], 'PX', ARGV[2])
  end
  return 'OK'
`);

// KEYS: seat map.  ARGV: hold TTL ms, hold id, hold key prefix, seat numbers...
const markHeldScript = luaScript(`
  local hasMap = redis.call('EXISTS', KEYS[1]) == 1
  for i = 4, #ARGV do
    if hasMap then redis.call('SETBIT', KEYS[1], ARGV[i], 1) end
    redis.call('SET', ARGV[3] .. ARGV[i], ARGV[2], 'PX', ARGV[1])
  end
  return 1
`);

// KEYS: counter, seat map.  ARGV: count to give back, hold key prefix, seat numbers...
const releaseScript = luaScript(`
  if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('INCRBY', KEYS[1], ARGV[1]) end
  local hasMap = redis.call('EXISTS', KEYS[2]) == 1
  for i = 3, #ARGV do
    if hasMap then redis.call('SETBIT', KEYS[2], ARGV[i], 0) end
    redis.call('DEL', ARGV[2] .. ARGV[i])
  end
  return 1
`);

export interface SeatGroup {
  eventId: number;
  sectionId: number;
  classId: number;
}

/**
 * Atomic pre-check before a hold: decrement the class counter by `count` and
 * mark the chosen seats, or refuse without touching the database.
 * Returns UNKNOWN when Redis has no data (or is down): the database decides alone.
 */
export function reserve(
  group: SeatGroup & { count: number; seatNos: number[]; holdId: string; ttlMs: number },
): Promise<ReserveResult> {
  return withRedis(async () => {
    const result = await reserveScript(
      [keys.available(group.eventId, group.classId), keys.seatMap(group.eventId, group.sectionId)],
      [group.count, group.ttlMs, group.holdId, keys.holdPrefix(group.eventId, group.sectionId), ...group.seatNos],
    );
    return result as ReserveResult;
  }, "UNKNOWN");
}

/**
 * Undo a successful `reserve` after the database refused the hold. The seat map
 * is dropped (it will be rebuilt from the database) because some of the marked
 * seats may really belong to someone else.
 */
export function undoReserve(group: SeatGroup & { count: number; seatNos: number[] }): Promise<void> {
  return withRedis(async () => {
    const holdPrefix = keys.holdPrefix(group.eventId, group.sectionId);
    await redis
      .multi()
      .incrby(keys.available(group.eventId, group.classId), group.count)
      .del(keys.seatMap(group.eventId, group.sectionId), ...group.seatNos.map((seat) => holdPrefix + seat))
      .exec();
  }, undefined);
}

/** Mirror a database hold whose seats were picked by the database (best-available mode). */
export function markHeld(group: SeatGroup & { seatNos: number[]; holdId: string; ttlMs: number }): Promise<void> {
  return withRedis(async () => {
    await markHeldScript(
      [keys.seatMap(group.eventId, group.sectionId)],
      [group.ttlMs, group.holdId, keys.holdPrefix(group.eventId, group.sectionId), ...group.seatNos],
    );
  }, undefined);
}

/** Seats went back to AVAILABLE (hold expired or cancelled): restore the counter and free their bits. */
export function release(group: SeatGroup & { seatNos: number[] }): Promise<void> {
  return withRedis(async () => {
    await releaseScript(
      [keys.available(group.eventId, group.classId), keys.seatMap(group.eventId, group.sectionId)],
      [group.seatNos.length, keys.holdPrefix(group.eventId, group.sectionId), ...group.seatNos],
    );
  }, undefined);
}

/** Seats were booked: their bits stay set; the hold keys are no longer needed. */
export function confirmBooked(group: Omit<SeatGroup, "classId"> & { seatNos: number[] }): Promise<void> {
  if (group.seatNos.length === 0) return Promise.resolve();
  const holdPrefix = keys.holdPrefix(group.eventId, group.sectionId);
  return withRedis(async () => {
    await redis.del(...group.seatNos.map((seat) => holdPrefix + seat));
  }, undefined);
}

// ------------------------------------------------------------------ availability counters

/** Remaining seats per (event, class). Missing entries mean "not cached". */
export function getAvailable(pairs: { eventId: number; classId: number }[]): Promise<(number | null)[]> {
  if (pairs.length === 0) return Promise.resolve([]);
  const unknown = pairs.map(() => null);
  return withRedis(async () => {
    const values = await redis.mget(pairs.map((p) => keys.available(p.eventId, p.classId)));
    return values.map((v) => (v === null ? null : Number(v)));
  }, unknown);
}

/**
 * Store counters computed from the database.
 * `overwrite: false` only fills missing keys (safe while holds are running);
 * `overwrite: true` is the periodic reconciliation.
 */
export function setAvailable(
  counts: { eventId: number; classId: number; available: number }[],
  { overwrite }: { overwrite: boolean },
): Promise<void> {
  return withRedis(async () => {
    const pipeline = redis.pipeline();
    for (const c of counts) {
      const key = keys.available(c.eventId, c.classId);
      if (overwrite) pipeline.set(key, c.available);
      else pipeline.set(key, c.available, "NX");
    }
    await pipeline.exec();
  }, undefined);
}

// ------------------------------------------------------------------ seat bitmaps

/** Seat numbers that are taken (held or booked), or null if the bitmap is not cached. */
export function getTakenSeats(eventId: number, sectionId: number): Promise<Set<number> | null> {
  return withRedis(async () => {
    const bitmap = await redis.getBuffer(keys.seatMap(eventId, sectionId));
    if (!bitmap) return null;
    const taken = new Set<number>();
    for (let byte = 0; byte < bitmap.length; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        // Redis numbers bits from the most significant bit of the first byte.
        if (bitmap[byte] & (0x80 >> bit)) taken.add(byte * 8 + bit);
      }
    }
    return taken;
  }, null);
}

/** Forget every cached seat map; each is rebuilt from its shard on the next read. */
export function dropSeatMaps(): Promise<void> {
  return withRedis(async () => {
    let cursor = "0";
    do {
      const [next, found] = await redis.scan(cursor, "MATCH", "seatmap:*", "COUNT", 1000);
      if (found.length) await redis.del(...found);
      cursor = next;
    } while (cursor !== "0");
  }, undefined);
}

/** Cache a seat map rebuilt from the database (only if nobody rebuilt it meanwhile). */
export function storeTakenSeats(eventId: number, sectionId: number, seatCount: number, taken: number[]): Promise<void> {
  const bitmap = Buffer.alloc(Math.ceil((seatCount + 1) / 8)); // seats are numbered from 1
  for (const seat of taken) bitmap[seat >> 3] |= 0x80 >> (seat & 7);
  return withRedis(async () => {
    await redis.set(keys.seatMap(eventId, sectionId), bitmap, "NX");
  }, undefined);
}
