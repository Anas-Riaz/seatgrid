import { cluster } from "../cluster/cluster.js";
import type { Client } from "../cluster/dbNode.js";
import type { Shard } from "../cluster/shard.js";
import { AppError, conflict, paymentRequired, SqlState, sqlState } from "../errors.js";
import * as inventoryCache from "../redis/inventoryCache.js";
import { type CrashPoint, runTwoPhaseCommit } from "../transactions/twoPhaseCommit.js";
import { releaseHold } from "./holds.js";
import { makeTicketNo } from "./ticketNumbers.js";

export interface BookingRequest {
  eventId: number;
  sectionId: number;
  holdId: string;
  idempotencyKey: string;
}

interface Ticket {
  ticket_no: string;
  seat_no: number;
  class_id: number;
  price: number;
}

/**
 * Step 2 of buying: turn a hold into tickets and pay for them.
 *
 * A booking changes two shards that are usually different machines:
 *   seat shard (Ring A)  seats -> BOOKED, insert order + bookings
 *   user shard (Ring B)  debit wallet, insert user_tickets
 * Both commit or neither does, via Two-Phase Commit.
 *
 * Retries are safe: the idempotency key is the primary key of `orders`, so a
 * repeated request returns the original result instead of booking twice.
 */
export async function confirmBooking(username: string, request: BookingRequest, crashAfter?: CrashPoint) {
  const seatShard = cluster.shardForSection(request.eventId, request.sectionId);
  const userShard = cluster.shardForUser(username);

  const previous = await findOrder(seatShard, request.idempotencyKey, username);
  if (previous) return previous;

  let tickets: Ticket[] = [];
  try {
    await runTwoPhaseCommit(
      [
        {
          name: "seats",
          shard: seatShard,
          work: async (client) => {
            tickets = await bookHeldSeats(client, username, request);
          },
        },
        {
          name: "wallet",
          shard: userShard,
          work: (client) => payForTickets(client, username, request, tickets),
        },
      ],
      crashAfter,
    );
  } catch (err) {
    // The same request raced with itself (double click, client retry): the loser either
    // hits the orders primary key or finds the seats already booked. Return the winner's result.
    const lostRace = sqlState(err) === SqlState.uniqueViolation || (err instanceof AppError && err.status === 409);
    if (lostRace) {
      const original = await findOrder(seatShard, request.idempotencyKey, username);
      if (original) return original;
    }
    // Give the seats back right away instead of waiting for the hold to expire.
    if (err instanceof AppError && err.status === 402) {
      await releaseHold(username, request.eventId, request.sectionId, request.holdId).catch(() => {});
    }
    throw err;
  }

  await inventoryCache.confirmBooked({ ...request, seatNos: tickets.map((t) => t.seat_no) });
  return toResult(request, tickets);
}

/** Participant 1 (seat shard): the held seats become booked tickets. */
async function bookHeldSeats(client: Client, username: string, r: BookingRequest): Promise<Ticket[]> {
  const { rows: seats } = await client.query<{ seat_no: number; class_id: number; price: number }>(
    `UPDATE seats SET status = 'BOOKED', hold_id = NULL, held_by = NULL, held_until = NULL
     WHERE event_id = $1 AND section_id = $2 AND hold_id = $3 AND held_by = $4
       AND status = 'HELD' AND held_until > now()
     RETURNING seat_no, class_id, price`,
    [r.eventId, r.sectionId, r.holdId, username],
  );
  if (seats.length === 0) throw conflict("Hold not found or expired, please choose seats again");

  const tickets = seats.map((s) => ({ ...s, ticket_no: makeTicketNo(r.eventId, r.sectionId, s.seat_no) }));
  const total = tickets.reduce((sum, t) => sum + t.price, 0);

  await client.query(
    `INSERT INTO orders (idempotency_key, username, event_id, section_id, total) VALUES ($1, $2, $3, $4, $5)`,
    [r.idempotencyKey, username, r.eventId, r.sectionId, total],
  );
  await client.query(
    `INSERT INTO bookings (ticket_no, idempotency_key, event_id, section_id, seat_no, class_id, username, price)
     SELECT ticket_no, $1, $2, $3, seat_no, class_id, $4, price
     FROM unnest($5::text[], $6::int[], $7::smallint[], $8::numeric[]) AS t(ticket_no, seat_no, class_id, price)`,
    [
      r.idempotencyKey,
      r.eventId,
      r.sectionId,
      username,
      tickets.map((t) => t.ticket_no),
      tickets.map((t) => t.seat_no),
      tickets.map((t) => t.class_id),
      tickets.map((t) => t.price),
    ],
  );
  return tickets;
}

/** Participant 2 (user shard): debit the wallet and index the tickets under the user. */
async function payForTickets(client: Client, username: string, r: BookingRequest, tickets: Ticket[]): Promise<void> {
  const total = tickets.reduce((sum, t) => sum + t.price, 0);
  try {
    await client.query("UPDATE wallets SET balance = balance - $2 WHERE username = $1", [username, total]);
  } catch (err) {
    // CHECK (balance >= 0) failed: vote NO.
    if (sqlState(err) === SqlState.checkViolation) throw paymentRequired("Not enough money in your wallet");
    throw err;
  }
  await client.query(
    `INSERT INTO user_tickets (username, ticket_no, event_id, section_id, seat_no, price)
     SELECT $1, ticket_no, $2, $3, seat_no, price
     FROM unnest($4::text[], $5::int[], $6::numeric[]) AS t(ticket_no, seat_no, price)`,
    [username, r.eventId, r.sectionId, tickets.map((t) => t.ticket_no), tickets.map((t) => t.seat_no), tickets.map((t) => t.price)],
  );
}

async function findOrder(seatShard: Shard, idempotencyKey: string, username: string) {
  const tickets = await seatShard.primary.query<Ticket & { username: string; event_id: number; section_id: number }>(
    `SELECT ticket_no, seat_no, class_id, price, username, event_id, section_id
     FROM bookings WHERE idempotency_key = $1 ORDER BY seat_no`,
    [idempotencyKey],
  );
  if (tickets.length === 0) return null;
  if (tickets[0].username !== username) throw conflict("Idempotency key was already used by another user");
  const { event_id: eventId, section_id: sectionId } = tickets[0];
  return { ...toResult({ eventId, sectionId }, tickets), replayed: true };
}

function toResult(r: { eventId: number; sectionId: number }, tickets: Ticket[]) {
  return {
    eventId: r.eventId,
    sectionId: r.sectionId,
    total: tickets.reduce((sum, t) => sum + t.price, 0),
    tickets: tickets.map((t) => ({ ticketNo: t.ticket_no, seatNo: t.seat_no, price: t.price })),
    replayed: false,
  };
}
