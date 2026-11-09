import { cluster } from "../cluster/cluster.js";
import { notFound } from "../errors.js";

/**
 * Reference data (ticket classes, venues, sections, events) is copied to every
 * shard, so any shard's replica can answer catalog queries. The tiny, fixed
 * tables (classes and sections) are also kept in memory.
 */

export interface TicketClass {
  classId: number;
  name: string;
  priceMultiplier: number;
}

export interface Section {
  sectionId: number;
  name: string;
  classId: number;
  className: string;
  seatCount: number;
}

export interface EventRow {
  event_id: number;
  title: string;
  tournament: string;
  home_team: string;
  away_team: string;
  venue: string;
  city: string;
  start_time: string;
  base_price: number;
}

let ticketClasses: TicketClass[] = [];
let sections = new Map<number, Section>();

export async function loadReferenceData(): Promise<void> {
  const shard = cluster.anyShard();
  const classRows = await shard.read<{ class_id: number; name: string; price_multiplier: number }>(
    "SELECT class_id, name, price_multiplier FROM ticket_classes ORDER BY class_id",
  );
  ticketClasses = classRows.map((c) => ({ classId: c.class_id, name: c.name, priceMultiplier: c.price_multiplier }));

  const sectionRows = await shard.read<{ section_id: number; name: string; class_id: number; seat_count: number }>(
    "SELECT section_id, name, class_id, seat_count FROM sections ORDER BY section_id",
  );
  sections = new Map(
    sectionRows.map((s) => [
      s.section_id,
      {
        sectionId: s.section_id,
        name: s.name,
        classId: s.class_id,
        className: ticketClasses.find((c) => c.classId === s.class_id)!.name,
        seatCount: s.seat_count,
      },
    ]),
  );
}

export const allTicketClasses = () => ticketClasses;
export const allSections = () => [...sections.values()];

export function getSection(sectionId: number): Section {
  const section = sections.get(sectionId);
  if (!section) throw notFound(`Section ${sectionId} does not exist`);
  return section;
}

export const EVENT_COLUMNS = `
  e.event_id, e.title, e.tournament, e.home_team, e.away_team,
  v.name AS venue, v.city, e.start_time, e.base_price`;

/** Event rows rarely change, so each coordinator keeps them in memory for a minute. */
const EVENT_CACHE_MS = 60_000;
const eventCache = new Map<number, { event: EventRow; cachedAt: number }>();

export async function getEvent(eventId: number): Promise<EventRow> {
  const cached = eventCache.get(eventId);
  if (cached && Date.now() - cached.cachedAt < EVENT_CACHE_MS) return cached.event;

  const [event] = await cluster.anyShard().read<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e JOIN venues v USING (venue_id) WHERE e.event_id = $1`,
    [eventId],
  );
  if (!event) throw notFound(`Event ${eventId} does not exist`);
  eventCache.set(eventId, { event, cachedAt: Date.now() });
  return event;
}

export async function allEventIds(): Promise<number[]> {
  const rows = await cluster.anyShard().read<{ event_id: number }>("SELECT event_id FROM events ORDER BY event_id");
  return rows.map((r) => r.event_id);
}

/** Events by id, from the local reference copy (used to label tickets and reports). */
export async function getEventsById(eventIds: number[]): Promise<Map<number, EventRow>> {
  if (eventIds.length === 0) return new Map();
  const rows = await cluster.anyShard().read<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e JOIN venues v USING (venue_id) WHERE e.event_id = ANY($1)`,
    [eventIds],
  );
  return new Map(rows.map((row) => [row.event_id, row]));
}
