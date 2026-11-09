import { cluster } from "../cluster/cluster.js";
import { badRequest, notFound } from "../errors.js";
import { getEventsById, getSection } from "./catalog.js";
import { parseTicketNo } from "./ticketNumbers.js";

/**
 * Lookup by ticket number: the number itself names the event and section, so
 * Ring A gives the owning shard directly (partition-aware routing, one shard).
 */
export async function lookupTicket(ticketNo: string) {
  const location = parseTicketNo(ticketNo);
  if (!location) throw badRequest("Ticket numbers look like E017-S05-0123-9F2A");

  const shard = cluster.shardForSection(location.eventId, location.sectionId);
  const sql = `
    SELECT b.ticket_no, b.event_id, b.section_id, b.seat_no, b.username, b.price, b.created_at,
           e.title, e.start_time, v.name AS venue, v.city
    FROM bookings b
    JOIN events e USING (event_id)
    JOIN venues v USING (venue_id)
    WHERE b.ticket_no = $1`;

  const params = [ticketNo.toUpperCase()];
  let [ticket] = await shard.read(sql, params);
  // A brand-new ticket may not have reached the replica yet: retry on the primary.
  if (!ticket) [ticket] = await shard.primary.query(sql, params);
  if (!ticket) throw notFound("Ticket not found");

  return { ...ticket, section: getSection(ticket.section_id).name, shard: shard.id };
}

/**
 * "My tickets" via the global secondary index user_tickets, which lives on the
 * user's own shard (Ring B) — no need to search every shard.
 */
export async function myTickets(username: string) {
  const shard = cluster.shardForUser(username);
  // Primary: right after a booking the replica may still be a moment behind.
  const tickets = await shard.primary.query<{ event_id: number; section_id: number }>(
    `SELECT ticket_no, event_id, section_id, seat_no, price, created_at
     FROM user_tickets WHERE username = $1
     ORDER BY created_at DESC`,
    [username],
  );
  const events = await getEventsById([...new Set(tickets.map((t) => t.event_id))]);
  return tickets.map((t) => ({
    ...t,
    section: getSection(t.section_id).name,
    title: events.get(t.event_id)?.title,
    start_time: events.get(t.event_id)?.start_time,
    venue: events.get(t.event_id)?.venue,
  }));
}
