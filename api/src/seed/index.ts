import pg from "pg";
import { HashRing, sectionKey, userKey } from "../cluster/hashRing.js";
import { config } from "../config.js";
import { redis } from "../redis/redis.js";
import { hashPassword } from "../services/passwords.js";
import { buildEvents, buildSections, TICKET_CLASSES, VENUES } from "./fixtures.js";

/**
 * One-shot seed job. Creates the dataset and places every row on its shard using
 * the same hash rings the coordinators use:
 *   reference data -> every shard
 *   seats          -> Ring A, hash(event, section)
 *   users, wallets -> Ring B, hash(username)
 * Publishing the shard map is the last step, so a half-finished seed is redone.
 */

const SEED_PASSWORD = "password123";
const USER_BATCH = 10_000;

const shardIds = Array.from({ length: config.seed.shardCount }, (_, i) => i + 1);
const ringA = new HashRing("A", shardIds, config.virtualNodes);
const ringB = new HashRing("B", shardIds, config.virtualNodes);

const primaryHost = (shardId: number) => `shard${shardId}-a:5432`;
const replicaHost = (shardId: number) => `shard${shardId}-b:5432`;

const meta = new pg.Pool({ connectionString: config.metaDatabaseUrl });
const shards = new Map(
  shardIds.map((id) => {
    const [host, port] = primaryHost(id).split(":");
    const pool = new pg.Pool({
      host,
      port: Number(port),
      user: config.shardDatabase.user,
      password: config.shardDatabase.password,
      database: config.shardDatabase.database,
      max: 4,
      // Bulk load: don't wait for each commit to be flushed to disk.
      options: "-c synchronous_commit=off",
    });
    return [id, pool];
  }),
);

const sections = buildSections(config.seed.seatsPerSection);
const events = buildEvents(config.seed.events);

async function main() {
  const { rows } = await meta.query("SELECT count(*)::int AS shards FROM shard_map");
  if (rows[0].shards > 0) {
    console.log("Shard map already published: cluster is seeded, nothing to do.");
    return;
  }

  const started = Date.now();
  console.log(`Seeding ${shardIds.length} shards: ${events.length} events, ${config.seed.users} users`);

  await forEachShard((db) =>
    db.query("TRUNCATE user_tickets, wallets, users, bookings, orders, seats, events, sections, venues, ticket_classes"),
  );
  await seedReferenceData();
  await seedUsers();
  await seedSeats();
  await forEachShard((db) => db.query("ANALYZE"));
  await primeRedis();
  await publishShardMap();

  console.log(`Seed finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

async function seedReferenceData() {
  await forEachShard(async (db) => {
    await db.query(
      `INSERT INTO ticket_classes (class_id, name, price_multiplier)
       SELECT * FROM unnest($1::smallint[], $2::text[], $3::numeric[])`,
      [TICKET_CLASSES.map((c) => c.classId), TICKET_CLASSES.map((c) => c.name), TICKET_CLASSES.map((c) => c.priceMultiplier)],
    );
    await db.query(
      `INSERT INTO venues (venue_id, name, city) SELECT * FROM unnest($1::int[], $2::text[], $3::text[])`,
      [VENUES.map((v) => v.venueId), VENUES.map((v) => v.name), VENUES.map((v) => v.city)],
    );
    await db.query(
      `INSERT INTO sections (section_id, name, class_id, seat_count)
       SELECT * FROM unnest($1::smallint[], $2::text[], $3::smallint[], $4::int[])`,
      [sections.map((s) => s.sectionId), sections.map((s) => s.name), sections.map((s) => s.classId), sections.map((s) => s.seatCount)],
    );
    await db.query(
      `INSERT INTO events (event_id, title, tournament, home_team, away_team, venue_id, start_time, base_price,
                           search_text, search_vector)
       SELECT e.event_id, e.title, e.tournament, e.home_team, e.away_team, e.venue_id, e.start_time, e.base_price,
              lower(concat_ws(' ', e.title, e.tournament, v.name, v.city)),
              to_tsvector('simple', concat_ws(' ', e.title, e.tournament, v.name, v.city))
       FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::timestamptz[], $8::numeric[])
            AS e(event_id, title, tournament, home_team, away_team, venue_id, start_time, base_price)
       JOIN venues v USING (venue_id)`,
      [
        events.map((e) => e.eventId),
        events.map((e) => e.title),
        events.map((e) => e.tournament),
        events.map((e) => e.homeTeam),
        events.map((e) => e.awayTeam),
        events.map((e) => e.venueId),
        events.map((e) => e.startTime),
        events.map((e) => e.basePrice),
      ],
    );
  });
  console.log("Reference data copied to every shard");
}

async function seedUsers() {
  // Every seeded user shares one password hash (hashing a million passwords would take minutes).
  const passwordHash = await hashPassword(SEED_PASSWORD);
  await insertUsers(["admin", "demo"], passwordHash);
  await shards.get(ringB.shardFor(userKey("admin")))!.query("UPDATE users SET is_admin = true WHERE username = 'admin'");

  for (let first = 1; first <= config.seed.users; first += USER_BATCH) {
    const last = Math.min(first + USER_BATCH - 1, config.seed.users);
    const usernames = Array.from({ length: last - first + 1 }, (_, i) => `user${String(first + i).padStart(7, "0")}`);
    await insertUsers(usernames, passwordHash);
    if (last % 100_000 === 0 || last === config.seed.users) console.log(`Users: ${last}/${config.seed.users}`);
  }
}

/** Groups usernames by their Ring B shard and inserts each group with its wallet. */
async function insertUsers(usernames: string[], passwordHash: string) {
  const byShard = groupBy(usernames, (username) => ringB.shardFor(userKey(username)));
  await Promise.all(
    [...byShard].map(([shardId, names]) =>
      shards.get(shardId)!.query(
        `WITH new_users AS (
           INSERT INTO users (username, email, password_hash)
           SELECT name, name || '@example.com', $2 FROM unnest($1::text[]) AS name
           RETURNING username
         )
         INSERT INTO wallets (username, balance, opening_balance)
         SELECT username, $3, $3 FROM new_users`,
        [names, passwordHash, config.wallet.openingBalance],
      ),
    ),
  );
}

async function seedSeats() {
  for (const event of events) {
    const byShard = groupBy(sections, (section) => ringA.shardFor(sectionKey(event.eventId, section.sectionId)));
    await Promise.all(
      [...byShard].map(([shardId, shardSections]) =>
        shards.get(shardId)!.query(
          `INSERT INTO seats (event_id, section_id, seat_no, class_id, price)
           SELECT $1, s.section_id, seat_no, s.class_id, s.price
           FROM unnest($2::smallint[], $3::smallint[], $4::numeric[]) AS s(section_id, class_id, price)
           CROSS JOIN generate_series(1, $5) AS seat_no`,
          [
            event.eventId,
            shardSections.map((s) => s.sectionId),
            shardSections.map((s) => s.classId),
            shardSections.map((s) => Math.round(event.basePrice * multiplierOf(s.classId))),
            config.seed.seatsPerSection,
          ],
        ),
      ),
    );
    if (event.eventId % 10 === 0 || event.eventId === events.length) {
      console.log(`Seats: event ${event.eventId}/${events.length}`);
    }
  }
}

/** Fresh cluster: clear old cache entries and set every availability counter. */
async function primeRedis() {
  await redis.flushdb();
  const pipeline = redis.pipeline();
  for (const event of events) {
    for (const ticketClass of TICKET_CLASSES) {
      const seats = sections.filter((s) => s.classId === ticketClass.classId).length * config.seed.seatsPerSection;
      pipeline.set(`avail:${event.eventId}:${ticketClass.classId}`, seats);
    }
  }
  await pipeline.exec();
  console.log("Redis availability counters primed");
}

async function publishShardMap() {
  await meta.query(
    `INSERT INTO shard_map (shard_id, primary_host, replica_host)
     SELECT * FROM unnest($1::int[], $2::text[], $3::text[])`,
    [shardIds, shardIds.map(primaryHost), shardIds.map(replicaHost)],
  );
  console.log(`Shard map published: ${shardIds.map((id) => `${id}=${primaryHost(id)}+${replicaHost(id)}`).join(", ")}`);
}

// ------------------------------------------------------------------ helpers

const multiplierOf = (classId: number) => TICKET_CLASSES.find((c) => c.classId === classId)!.priceMultiplier;

function forEachShard(fn: (db: pg.Pool) => Promise<unknown>) {
  return Promise.all([...shards.values()].map(fn));
}

function groupBy<T>(items: T[], keyOf: (item: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
