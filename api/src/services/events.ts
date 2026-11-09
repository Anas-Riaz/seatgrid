import { cluster } from "../cluster/cluster.js";
import { config } from "../config.js";
import * as inventoryCache from "../redis/inventoryCache.js";
import { redis, withRedis } from "../redis/redis.js";
import { availableByEvent } from "./availability.js";
import { allSections, EVENT_COLUMNS, type EventRow, getEvent, getSection } from "./catalog.js";
import { scatterRead } from "./scatterGather.js";

export interface EventSearch {
  q?: string;
  city?: string;
  minPrice?: number;
  maxPrice?: number;
  from?: string;
  to?: string;
  sort: "date" | "price" | "title" | "availability";
  order: "asc" | "desc";
  page: number;
  limit: number;
}

const SORT_COLUMNS = { date: "e.start_time", price: "e.base_price", title: "e.title" } as const;

/**
 * Text search, numeric/date filters and sorting.
 * The catalog is replicated, so the whole query runs on ONE shard replica using its
 * local GIN (full-text + trigram) and B-tree indexes. Availability comes from Redis.
 */
export async function searchEvents(search: EventSearch) {
  // Cache-aside: identical searches within a couple of seconds share one result
  // (a slightly stale seat count does no harm on this AP-leaning path).
  const cacheKey = `search:${JSON.stringify(search)}`;
  const cached = await withRedis(() => redis.get(cacheKey), null);
  if (cached) return JSON.parse(cached) as Awaited<ReturnType<typeof runSearch>>;

  const result = await runSearch(search);
  await withRedis(() => redis.set(cacheKey, JSON.stringify(result), "EX", config.searchCacheSeconds), null);
  return result;
}

async function runSearch(search: EventSearch) {
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const where: string[] = [];
  if (search.q) {
    const q = param(search.q);
    // Whole words via full-text search, partial words ("kara") via the trigram index.
    where.push(`(e.search_vector @@ websearch_to_tsquery('simple', ${q}) OR e.search_text ILIKE '%' || ${q} || '%')`);
  }
  if (search.city) where.push(`v.city ILIKE ${param(search.city)}`);
  if (search.minPrice !== undefined) where.push(`e.base_price >= ${param(search.minPrice)}`);
  if (search.maxPrice !== undefined) where.push(`e.base_price <= ${param(search.maxPrice)}`);
  if (search.from) where.push(`e.start_time >= ${param(search.from)}`);
  if (search.to) where.push(`e.start_time <= ${param(search.to)}`);

  // Availability lives in Redis, so that sort happens here after fetching all matches.
  const sortInDatabase = search.sort !== "availability";
  const direction = search.order === "desc" ? "DESC" : "ASC";
  const orderBy = sortInDatabase ? `${SORT_COLUMNS[search.sort as keyof typeof SORT_COLUMNS]} ${direction}, e.event_id` : "e.event_id";
  const offset = (search.page - 1) * search.limit;
  const paging = sortInDatabase ? `LIMIT ${param(search.limit)} OFFSET ${param(offset)}` : "";

  const rows = await cluster.anyShard().read<EventRow & { total: number }>(
    `SELECT ${EVENT_COLUMNS}, count(*) OVER () AS total
     FROM events e JOIN venues v USING (venue_id)
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${orderBy}
     ${paging}`,
    params,
  );

  const available = await availableByEvent(rows.map((r) => r.event_id));
  let results = rows.map(({ total, ...event }) => ({ ...event, available_seats: available.get(event.event_id)! }));

  if (!sortInDatabase) {
    const sign = search.order === "desc" ? -1 : 1;
    results.sort((a, b) => sign * (a.available_seats - b.available_seats) || a.event_id - b.event_id);
    results = results.slice(offset, offset + search.limit);
  }

  return { page: search.page, limit: search.limit, total: rows[0]?.total ?? 0, results };
}

/**
 * One event with free/total seats per section. Sections of one event live on
 * different shards (Ring A), so this is a scatter-gather over all shards.
 */
export async function getEventDetail(eventId: number) {
  const event = await getEvent(eventId);
  const counts = await scatterRead<{ section_id: number; available: number; total: number; price: number }>(
    `SELECT section_id,
            count(*) FILTER (WHERE status = 'AVAILABLE') AS available,
            count(*) AS total,
            min(price) AS price
     FROM seats WHERE event_id = $1
     GROUP BY section_id`,
    [eventId],
  );
  const bySection = new Map(counts.map((c) => [c.section_id, c]));

  const sections = allSections().map((section) => ({
    ...section,
    price: bySection.get(section.sectionId)?.price ?? null,
    available: bySection.get(section.sectionId)?.available ?? 0,
    total: bySection.get(section.sectionId)?.total ?? 0,
  }));
  return { ...event, sections };
}

/**
 * Live seat map of one section: served from the Redis bitmap, rebuilt from the
 * owning shard's primary when the bitmap is missing.
 */
export async function getSeatMap(eventId: number, sectionId: number) {
  const event = await getEvent(eventId);
  const section = getSection(sectionId);

  let taken = await inventoryCache.getTakenSeats(eventId, sectionId);
  if (!taken) {
    const rows = await cluster
      .shardForSection(eventId, sectionId)
      .primary.query<{ seat_no: number }>(
        "SELECT seat_no FROM seats WHERE event_id = $1 AND section_id = $2 AND status <> 'AVAILABLE'",
        [eventId, sectionId],
      );
    taken = new Set(rows.map((r) => r.seat_no));
    await inventoryCache.storeTakenSeats(eventId, sectionId, section.seatCount, [...taken]);
  }

  return {
    eventId,
    title: event.title,
    section,
    seatCount: section.seatCount,
    taken: [...taken].sort((a, b) => a - b),
  };
}
