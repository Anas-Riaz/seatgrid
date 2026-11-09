import { randomUUID } from "node:crypto";
import { cluster } from "../cluster/cluster.js";
import type { Client } from "../cluster/dbNode.js";
import { config } from "../config.js";
import { badRequest, conflict, notFound } from "../errors.js";
import * as inventoryCache from "../redis/inventoryCache.js";
import { getSection } from "./catalog.js";

export interface HoldRequest {
  eventId: number;
  sectionId: number;
  /** Either specific seats... */
  seatNos?: number[];
  /** ...or "any N seats" (best available). */
  quantity?: number;
}

interface HeldSeat {
  seat_no: number;
  price: number;
}

const HOLD_COLUMNS = `
  status = 'HELD', hold_id = $3, held_by = $4,
  held_until = now() + make_interval(secs => $5)`;

/**
 * Step 1 of buying: temporarily reserve seats (a "hold") so the user can pay.
 *
 * Protection layers against double booking:
 *   1. Redis: atomic counter + seat bitmap reject sold-out / taken seats early.
 *   2. Database: an atomic compare-and-set update only succeeds on AVAILABLE seats.
 *      In best-available mode, SKIP LOCKED lets buyers take different seats
 *      instead of queuing behind each other.
 *   3. UNIQUE(event, section, seat) on bookings (enforced when the hold is booked).
 */
export async function createHold(username: string, request: HoldRequest) {
  const { eventId, sectionId } = request;
  const section = getSection(sectionId);
  const seatNos = request.seatNos ? [...new Set(request.seatNos)] : undefined;
  const count = seatNos?.length ?? request.quantity ?? 0;

  if (count < 1 || count > config.holds.maxSeats) {
    throw badRequest(`Choose between 1 and ${config.holds.maxSeats} seats`);
  }
  if (seatNos?.some((seat) => seat < 1 || seat > section.seatCount)) {
    throw badRequest(`Seat numbers must be between 1 and ${section.seatCount}`);
  }

  const holdId = randomUUID();
  const ttlMs = config.holds.ttlSeconds * 1000;
  const seatGroup = { eventId, sectionId, classId: section.classId };

  // Layer 1: Redis pre-check.
  const precheck = await inventoryCache.reserve({ ...seatGroup, count, seatNos: seatNos ?? [], holdId, ttlMs });
  if (precheck === "SOLD_OUT") throw conflict(`Not enough ${section.className} seats left`);
  if (precheck === "TAKEN") throw conflict("Seat already taken");

  // Layer 2: atomic update on the shard that owns this section.
  try {
    const shard = cluster.shardForSection(eventId, sectionId);
    const seats = await shard.primary.transaction(async (client) => {
      const held = seatNos
        ? await holdChosenSeats(client, request, seatNos, holdId, username)
        : await holdBestAvailable(client, request, count, holdId, username);
      if (held.length < count) {
        throw conflict(seatNos ? "Seat already taken" : `Only ${held.length} seats left in this section`);
      }
      return held;
    });

    if (!seatNos) {
      await inventoryCache.markHeld({ ...seatGroup, seatNos: seats.map((s) => s.seat_no), holdId, ttlMs });
    }

    return {
      holdId,
      eventId,
      sectionId,
      seats: seats.map((s) => ({ seatNo: s.seat_no, price: s.price })),
      total: seats.reduce((sum, s) => sum + s.price, 0),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  } catch (err) {
    if (precheck === "OK") await inventoryCache.undoReserve({ ...seatGroup, count, seatNos: seatNos ?? [] });
    throw err;
  }
}

/** Compare-and-set: only seats that are still AVAILABLE change. All or nothing (caller checks the count). */
function holdChosenSeats(client: Client, r: HoldRequest, seatNos: number[], holdId: string, username: string) {
  return client
    .query<HeldSeat>(
      `UPDATE seats SET ${HOLD_COLUMNS}
       WHERE event_id = $1 AND section_id = $2 AND seat_no = ANY($6) AND status = 'AVAILABLE'
       RETURNING seat_no, price`,
      [r.eventId, r.sectionId, holdId, username, config.holds.ttlSeconds, seatNos],
    )
    .then((result) => result.rows);
}

/** Lowest-numbered free seats; rows another buyer has locked are skipped, not waited for. */
function holdBestAvailable(client: Client, r: HoldRequest, count: number, holdId: string, username: string) {
  return client
    .query<HeldSeat>(
      `WITH picked AS (
         SELECT seat_no FROM seats
         WHERE event_id = $1 AND section_id = $2 AND status = 'AVAILABLE'
         ORDER BY seat_no
         LIMIT $6
         FOR UPDATE SKIP LOCKED
       )
       UPDATE seats s SET ${HOLD_COLUMNS}
       FROM picked
       WHERE s.event_id = $1 AND s.section_id = $2 AND s.seat_no = picked.seat_no
       RETURNING s.seat_no, s.price`,
      [r.eventId, r.sectionId, holdId, username, config.holds.ttlSeconds, count],
    )
    .then((result) => result.rows);
}

/** Give held seats back (user cancelled, or the booking failed). */
export async function releaseHold(username: string, eventId: number, sectionId: number, holdId: string) {
  const section = getSection(sectionId);
  const rows = await cluster
    .shardForSection(eventId, sectionId)
    .primary.query<{ seat_no: number }>(
      `UPDATE seats SET status = 'AVAILABLE', hold_id = NULL, held_by = NULL, held_until = NULL
       WHERE event_id = $1 AND section_id = $2 AND hold_id = $3 AND held_by = $4 AND status = 'HELD'
       RETURNING seat_no`,
      [eventId, sectionId, holdId, username],
      "write",
    );
  if (rows.length === 0) throw notFound("Hold not found or already expired");

  await inventoryCache.release({ eventId, sectionId, classId: section.classId, seatNos: rows.map((r) => r.seat_no) });
  return { released: rows.length };
}
