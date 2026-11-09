import { cluster } from "../cluster/cluster.js";
import { config } from "../config.js";
import { currentLeader } from "../redis/leaderLease.js";
import * as inventoryCache from "../redis/inventoryCache.js";
import { countAvailableSeats } from "./availability.js";
import { allEventIds, allTicketClasses, getEventsById } from "./catalog.js";
import { mergeSorted, scatter, scatterRead } from "./scatterGather.js";
import { recentTransactions } from "../transactions/txLog.js";

/** Sales per event and class: every shard returns partial SUM/COUNT, the coordinator adds them up. */
export async function salesReport() {
  const partials = await scatterRead<{ event_id: number; class_id: number; tickets: number; revenue: number }>(
    `SELECT event_id, class_id, count(*) AS tickets, sum(price) AS revenue
     FROM bookings GROUP BY event_id, class_id`,
  );

  const totals = new Map<string, { event_id: number; class_id: number; tickets: number; revenue: number }>();
  for (const p of partials) {
    const key = `${p.event_id}:${p.class_id}`;
    const total = totals.get(key) ?? { event_id: p.event_id, class_id: p.class_id, tickets: 0, revenue: 0 };
    total.tickets += p.tickets;
    total.revenue += p.revenue;
    totals.set(key, total);
  }

  const events = await getEventsById([...new Set(partials.map((p) => p.event_id))]);
  const classNames = new Map(allTicketClasses().map((c) => [c.classId, c.name]));
  return [...totals.values()]
    .map((t) => ({ ...t, title: events.get(t.event_id)?.title, class: classNames.get(t.class_id) }))
    .sort((a, b) => b.revenue - a.revenue);
}

interface BookingRow {
  ticket_no: string;
  event_id: number;
  section_id: number;
  seat_no: number;
  username: string;
  price: number;
  created_at: Date;
}

/**
 * Bookings whose username starts with `prefix`, newest first, across all shards.
 * Each shard returns its own top `limit` (after the cursor); the coordinator
 * does a K-way merge and returns a cursor for the next page (keyset pagination).
 */
export async function searchBookings(prefix: string, limit: number, cursor?: string) {
  const [afterTime, afterTicket] = cursor ? decodeCursor(cursor) : [null, null];
  const perShard = await scatter((shard) =>
    shard.read<BookingRow>(
      `SELECT ticket_no, event_id, section_id, seat_no, username, price, created_at
       FROM bookings
       WHERE username LIKE $1 || '%'
         AND ($2::timestamptz IS NULL OR (created_at, ticket_no) < ($2, $3))
       ORDER BY created_at DESC, ticket_no DESC
       LIMIT $4`,
      [prefix, afterTime, afterTicket, limit],
    ),
  );

  const newestFirst = (a: BookingRow, b: BookingRow) =>
    b.created_at.getTime() - a.created_at.getTime() || b.ticket_no.localeCompare(a.ticket_no);
  const page = mergeSorted(perShard, newestFirst, limit);

  const last = page.at(-1);
  return {
    results: page,
    nextCursor: page.length === limit && last ? encodeCursor(last) : null,
  };
}

const encodeCursor = (row: BookingRow) =>
  Buffer.from(JSON.stringify([row.created_at.toISOString(), row.ticket_no])).toString("base64url");
const decodeCursor = (cursor: string) => JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];

/**
 * Global correctness checks, run after every load or failure test.
 * All of them must pass after any amount of chaos.
 */
export async function verifyConsistency() {
  const perShard = await scatter(async (shard) => {
    const [row] = await shard.primary.query<{
      double_booked: number;
      bookings: number;
      booked_seats: number;
      revenue: number;
      user_tickets: number;
      wallet_debits: number;
    }>(`
      SELECT
        (SELECT count(*) FROM (SELECT 1 FROM bookings GROUP BY event_id, section_id, seat_no HAVING count(*) > 1) d) AS double_booked,
        (SELECT count(*) FROM bookings)                                   AS bookings,
        (SELECT count(*) FROM seats WHERE status = 'BOOKED')               AS booked_seats,
        (SELECT coalesce(sum(price), 0) FROM bookings)                     AS revenue,
        (SELECT count(*) FROM user_tickets)                                AS user_tickets,
        (SELECT coalesce(sum(opening_balance - balance), 0) FROM wallets)  AS wallet_debits`);
    return { shard: shard.id, ...row };
  });

  const sum = (field: keyof (typeof perShard)[number]) => perShard.reduce((total, s) => total + Number(s[field]), 0);

  const counterMismatches = await compareRedisCounters();

  const checks = [
    { name: "No seat is booked twice", ok: sum("double_booked") === 0, detail: `${sum("double_booked")} seats with >1 booking` },
    {
      name: "Every ticket matches a BOOKED seat",
      ok: perShard.every((s) => s.bookings === s.booked_seats),
      detail: perShard.map((s) => `shard ${s.shard}: ${s.bookings} tickets / ${s.booked_seats} booked seats`).join("; "),
    },
    {
      name: "Every ticket is indexed under its owner (user_tickets)",
      ok: sum("user_tickets") === sum("bookings"),
      detail: `${sum("user_tickets")} user_tickets / ${sum("bookings")} bookings`,
    },
    {
      name: "Wallet debits equal revenue",
      ok: Math.abs(sum("wallet_debits") - sum("revenue")) < 0.01,
      detail: `debits ${sum("wallet_debits")} / revenue ${sum("revenue")}`,
    },
    {
      name: "Redis counters equal database counts",
      ok: counterMismatches.length === 0,
      detail: counterMismatches.length
        ? `${counterMismatches.length} counters differ (in-flight holds cause brief differences; reconciled every minute)`
        : "all cached counters match",
      mismatches: counterMismatches.slice(0, 10),
    },
  ];
  return { ok: checks.every((c) => c.ok), checks, perShard };
}

async function compareRedisCounters() {
  const counts = await countAvailableSeats(await allEventIds());
  const cached = await inventoryCache.getAvailable(counts);
  return counts
    .map((c, i) => ({ ...c, redis: cached[i] }))
    .filter((c) => c.redis !== null && c.redis !== c.available);
}

/** Shard map, node health, replication lag and the current leader — for the demo dashboard. */
export async function clusterStatus() {
  const shards = await Promise.all(
    cluster.all().map(async (shard) => {
      const replication = await shard.primary
        .query(
          `SELECT application_name, client_addr::text, state, sync_state,
                  extract(epoch FROM replay_lag) * 1000 AS replay_lag_ms
           FROM pg_stat_replication`,
        )
        .catch((err) => ({ error: (err as Error).message }));
      const replicaLag = shard.replica
        ? await shard.replica
            .query(
              `SELECT pg_is_in_recovery() AS in_recovery,
                      extract(epoch FROM now() - pg_last_xact_replay_timestamp()) * 1000 AS ms_since_last_replay`,
            )
            .then((rows) => rows[0])
            .catch((err) => ({ error: (err as Error).message }))
        : null;
      return {
        shardId: shard.id,
        primary: shard.primary.status,
        replica: shard.replica?.status ?? null,
        replication,
        replicaLag,
      };
    }),
  );

  return {
    servedBy: config.coordinatorId,
    leader: await currentLeader(),
    shardMapVersion: cluster.version,
    shardMap: cluster.shardMap,
    shards,
  };
}

export async function transactionLog() {
  const prepared = await scatter(async (shard) => ({
    shard: shard.id,
    prepared: await shard.primary
      .query("SELECT gid, prepared FROM pg_prepared_xacts WHERE database = current_database() ORDER BY prepared")
      .catch((err) => ({ error: (err as Error).message })),
  }));
  return { recent: await recentTransactions(20), preparedOnShards: prepared };
}
