# SeatGrid — Cricket Ticket Booking on a Distributed Database

CS 606 Distributed Database Systems — Syed Anas Riaz (B20102156)

SeatGrid is an IPL/PSL-style ticket booking system built on a **hand-built distributed
PostgreSQL cluster**:

- 3 shards, each a **primary + streaming replica**
- **two consistent-hash rings** route every row to a shard
- **application-level Two-Phase Commit** for bookings that span two shards
- **Redis** for availability, holds, rate limits and the leader lease
- **automatic failover** of a dead primary
- **admission control and load shedding**, so a flash sale cannot take the system down

Every container is one node. One command starts the whole cluster.

---

## Architecture

```
 Browser ─► gateway (NGINX :8080) ── round-robin, rate + connection limits, passive health checks
               ├─► web   (React UI)
               └─► api ×3  stateless coordinators: router (hash rings), query engine (scatter-gather),
                     │      2PC transaction manager, cache manager, admission control.
                     │      The one holding the Redis lease also runs failover + background jobs.
                     ├─► redis   counters, seat bitmaps, holds, username claims, rate limits, leader lease
                     ├─► meta    versioned shard map + 2PC decision log (tx_log)
                     └─► shard1-a ⇄ shard1-b   shard2-a ⇄ shard2-b   shard3-a ⇄ shard3-b
                          (primary)  (replica)  — asynchronous streaming replication per shard
```

| Data | Placement | Why |
|---|---|---|
| `events`, `venues`, `sections`, `ticket_classes` | copied to **every** shard | small, read-heavy, joined with everything |
| `seats`, `orders`, `bookings` | **Ring A**: `hash(event, section)` | one hot match is spread over all shards; seats and their bookings are co-located |
| `users`, `wallets`, `user_tickets` | **Ring B**: `hash(username)` | O(1) username check; "my tickets" is a single-shard query (global secondary index) |
| `shard_map`, `tx_log` | meta DB | tiny control data |

Ticket numbers encode their location — `E017-S05-0123-9F2A` is event 17, section 5, seat 123 —
so a lookup by ticket number goes straight to the right shard.

### Buying a ticket

| Step | What happens | Where |
|---|---|---|
| 1 | Admission control, rate limits (token buckets), validation | NGINX, coordinator, Redis |
| 2 | Atomic Lua pre-check: class counter ≥ N, chosen seats free → reserve, else refuse without touching PostgreSQL | Redis |
| 3 | **Hold**: compare-and-set `AVAILABLE → HELD` with expiry (`FOR UPDATE SKIP LOCKED` for best-available) | seat shard primary |
| 4 | **2PC phase 1**: seat shard books seats + inserts tickets; user shard debits wallet + indexes tickets; both `PREPARE TRANSACTION` | seat + user shard |
| 5 | Log `COMMITTING` in `tx_log` (the commit point), then `COMMIT PREPARED` on both | meta DB, both shards |
| 6 | Retry with the same idempotency key → the original tickets, never a second charge | `orders` primary key |

Double booking is stopped by three independent layers: the Redis pre-check, the atomic
row update, and `UNIQUE(event_id, section_id, seat_no)` on `bookings`.

---

## Where each part of the proposal lives

| Proposal | Code |
|---|---|
| Consistent hashing, 128 virtual nodes, Rings A and B (§6.2) | [api/src/cluster/hashRing.ts](api/src/cluster/hashRing.ts), [cluster.ts](api/src/cluster/cluster.ts) |
| Shard primary + replica, replica reads with primary fallback (§6.3) | [shard.ts](api/src/cluster/shard.ts), [infra/postgres/](infra/postgres) |
| Failover: health monitor, `pg_promote()`, shard-map version, fencing (§6.3) | [jobs/failover.ts](api/src/jobs/failover.ts) |
| Leader lease (§5) | [redis/leaderLease.ts](api/src/redis/leaderLease.ts) |
| Registration, constant-time username check (§7.1) | [services/users.ts](api/src/services/users.ts) |
| Holds, three-layer protection (§7.2, §8.1) | [services/holds.ts](api/src/services/holds.ts), [redis/inventoryCache.ts](api/src/redis/inventoryCache.ts) |
| Two-Phase Commit + durable log (§8.2) | [transactions/twoPhaseCommit.ts](api/src/transactions/twoPhaseCommit.ts), [txLog.ts](api/src/transactions/txLog.ts) |
| 2PC recovery worker (presumed abort) | [jobs/txRecovery.ts](api/src/jobs/txRecovery.ts) |
| Booking flow, idempotency | [services/bookings.ts](api/src/services/bookings.ts) |
| Search/sort (GIN full-text + trigram), ticket lookup, my tickets (§7.3) | [services/events.ts](api/src/services/events.ts), [tickets.ts](api/src/services/tickets.ts) |
| Partial aggregation, scatter-gather top-K + K-way merge (§7.3) | [services/reports.ts](api/src/services/reports.ts), [scatterGather.ts](api/src/services/scatterGather.ts) |
| Redis caching: counters, bitmaps, holds, cache-aside search (§9.1) | [redis/inventoryCache.ts](api/src/redis/inventoryCache.ts), [jobs/scheduler.ts](api/src/jobs/scheduler.ts) |
| Rate limiting, bounded pools, timeouts, circuit breakers, load shedding (§9.2) | [rateLimiter.ts](api/src/redis/rateLimiter.ts), [dbNode.ts](api/src/cluster/dbNode.ts), [bulkhead.ts](api/src/cluster/bulkhead.ts), [circuitBreaker.ts](api/src/cluster/circuitBreaker.ts), [admissionControl.ts](api/src/http/admissionControl.ts), [nginx.conf](infra/nginx/nginx.conf) |
| Hold expiry, counter reconciliation | [jobs/holdExpiry.ts](api/src/jobs/holdExpiry.ts), [jobs/scheduler.ts](api/src/jobs/scheduler.ts) |
| Consistency verifier (§11) | `verifyConsistency` in [services/reports.ts](api/src/services/reports.ts) |
| Seed generator: 1M users, 100 events, 2M seats (§4) | [api/src/seed/](api/src/seed) |
| k6 tests: race, flash sale, mixed workload, rate limit (§11) | [tests/k6/](tests/k6) |

---

## Running it (Windows)

Prerequisites: **Docker Desktop** (WSL 2 backend) and **Node.js 22** (only for UI development and
unit tests). Give Docker at least 8 GB of RAM if you can (`%UserProfile%\.wslconfig` → `[wsl2]` `memory=8GB`).

```powershell
cd D:\DDB\Project
copy .env.example .env          # optional: change dataset size, replicas, sync replication
docker compose up -d --build
docker compose logs -f seed     # wait for "Seed finished"
```

The full dataset (1,000,000 users, 100 matches, 2,000,000 seats) seeds in about 3 minutes.
For a quick start, set `SEED_USERS=20000` and `SEED_EVENTS=20` in `.env` (about 15 s).

Then open:

- **http://localhost:8080** — the web UI (log in as `demo` / `password123`)
- **http://localhost:8080/api/cluster** — shard map, replication lag, circuit breakers, leader
- [requests.http](requests.http) — every API call, ready to send from VS Code

Database connections (pgAdmin, DBeaver or the VS Code PostgreSQL extension) use host `localhost`,
user `postgres` and password `postgres`:

| Node | Port | Database |
|---|---|---|
| meta | 5500 | `meta` |
| shard N primary (`shardN-a`) | 55N1, e.g. 5511 | `seatgrid` |
| shard N replica (`shardN-b`) | 55N2, e.g. 5512 (read-only) | `seatgrid` |

Seeded accounts: `demo`, `admin` (admin reports), and `user0000001` … `user1000000`.
All use the password `password123`, and every wallet starts with PKR 100,000.

To start again from an empty cluster: `docker compose down -v`, then `docker compose up -d --build`.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | coordinator id, leader?, shard-map version |
| GET | `/api/cluster` | shard map, node health, replication lag |
| GET | `/api/events` | `q`, `city`, `minPrice`, `maxPrice`, `from`, `to`, `sort=date\|price\|title\|availability`, `order`, `page`, `limit` |
| GET | `/api/events/:id` | free seats per section |
| GET | `/api/events/:id/sections/:sectionId/seats` | live seat map |
| GET | `/api/auth/username-available?username=` | constant-time check |
| POST | `/api/auth/register`, `/api/auth/login` | returns a bearer token |
| GET | `/api/me`, `/api/me/tickets` | profile + wallet, my tickets |
| POST | `/api/holds` | `{eventId, sectionId, seatNos:[…]}` or `{…, quantity}` |
| DELETE | `/api/holds/:holdId?eventId=&sectionId=` | release a hold |
| POST | `/api/bookings` | `{eventId, sectionId, holdId, idempotencyKey}` |
| GET | `/api/tickets/:ticketNo` | lookup by ticket number |
| GET | `/api/admin/sales`, `/api/admin/bookings?username=`, `/api/admin/verify`, `/api/admin/transactions` | admin only |

---

## Tests and demos

In **PowerShell** the k6 commands below work as written. In **Git Bash**, prefix them with
`MSYS_NO_PATHCONV=1` so the container path `/tests/...` is not rewritten.

```powershell
# Unit tests (hash ring: determinism, balance, ~1/(N+1) movement when a shard is added)
cd api; npm install; npm test; cd ..

# 500 users race for ONE seat -> exactly one booking, verifier passes
docker compose --profile tools run --rm k6 run /tests/race-one-seat.js

# Flash sale: 2,000 users, 5,000 seats, 60 s ramp -> no crash, excess rejected, zero oversell
docker compose --profile tools run --rm k6 run /tests/flash-sale.js
docker compose --profile tools run --rm k6 run -e VUS=300 /tests/flash-sale.js   # smaller machines

# Mixed workload 80% search / 15% seat map / 5% booking (repeat with API_REPLICAS=1 vs 3)
docker compose --profile tools run --rm k6 run /tests/mixed-workload.js

# One user hammering the API -> 429 + Retry-After
docker compose --profile tools run --rm k6 run /tests/rate-limit.js
```

Every k6 test that books tickets runs the **consistency verifier** at the end. Its checks:

- no seat is booked twice
- tickets equal booked seats on every shard
- `user_tickets` equals `bookings`
- wallet debits equal revenue
- Redis counters equal database counts

### Failure demos

| Demo | Command | What to watch |
|---|---|---|
| Primary crash → failover | `docker stop shard1-a` | `docker compose logs -f api` shows `promoted shard1-b … (6s after it went down)`; `/api/cluster` shows the new primary; other shards are unaffected. Then `docker start shard1-a`: it is **fenced** (read-only). |
| Replica down | `docker stop shard2-b` | reads fall back to `shard2-a`; nothing fails |
| Coordinator crash | `docker kill project-api-1` | NGINX stops routing to it; if it held the lease another coordinator takes over within ~5 s |
| Redis down | `docker stop redis` | search, seat maps and bookings keep working from the databases (slower); on `docker start redis` the cache is rebuilt |
| Partition | `docker network disconnect project_default shard3-a` | coordinators can no longer resolve the node: its requests fail fast (circuit breaker), the monitor treats it like a crash and fails over to `shard3-b`; other shards are unaffected |
| 2PC: crash before the decision | send a booking with header `X-Crash-After: prepare` | the coordinator exits; after ~15 s the recovery worker sees no decision and issues `ROLLBACK PREPARED` (presumed abort) |
| 2PC: crash after the decision | header `X-Crash-After: decision` | the log says `COMMITTING`; recovery issues `COMMIT PREPARED` on both shards; tickets and wallet debit appear |

Watch the 2PC demos at `GET /api/admin/transactions` (log + prepared transactions per shard).
Crash injection is enabled by `CRASH_INJECTION=on` in compose (development only).

### Experiments for the report

- **Scale-out, coordinators:** `API_REPLICAS=1` vs `3` in `.env`, then `docker compose up -d`, then run `mixed-workload.js`.
- **Scale-out, shards:** `SHARD_COUNT=1` vs `3` in `.env`, then `docker compose down -v`, then `docker compose up -d --build`, then run `mixed-workload.js`.
- **Replication (PACELC):** `SYNC_STANDBY_NAMES='*'` in `.env` for synchronous replication, then `docker compose down -v`, then `docker compose up -d --build`. Compare booking latency and `/api/cluster` replication lag with the asynchronous default.
- **Query plans:** `docker exec -it shard1-a psql -U postgres -d seatgrid`, then
  `EXPLAIN ANALYZE SELECT * FROM events WHERE search_vector @@ websearch_to_tsquery('simple','karachi');`

### Results measured on the development machine

The machine was a 4-core Windows laptop: Docker Desktop with 4 vCPUs and 4 GB shared by all
14 containers, the load generator and Windows itself. Full proposal dataset.

| Measure | Target | Result |
|---|---|---|
| Double bookings after any test | 0 | **0** (verifier passes after race, flash-sale, failover, Redis-down and 2PC-crash tests) |
| 500 users racing for one seat | 1 booking | **exactly 1**; 494 refused "seat taken", the rest shed with 503 |
| Flash sale, 2,000 users | no crash | **no crash**; excess shed with 409/429/503; zero oversell |
| Failover after `docker stop` | < 30 s | **6–9 s**; only that shard's writes paused |
| Search, idle / single user | < 300 ms | ~100–200 ms |
| p95 latency at 2,000 users | search < 300 ms, booking < 1.5 s | **not met on this hardware** |

The p95 targets are missed because the machine is CPU-bound. On this setup, even an empty
`/health` request through NGINX tops out at about 270 req/s. Run the load tests on a machine with
8+ cores (or lower `VUS`) to compare latency.

---

## Design notes

**CAP / PACELC.**

- *Booking, wallet and holds* are **CP / PC-EC**. They always use the shard primary, and if it is
  unreachable the request is refused (fast 503) rather than guessed.
- *Search, catalog and history* are **AP-leaning / PA-EL**. They read replicas and a 2-second
  search cache, and may be slightly stale.

**Failover safety.** Promoting a replica while the old primary is merely *busy* would lose its
latest (asynchronously replicated) transactions. An early version did exactly this under
flash-sale load. So the monitor only counts definitive failures as DOWN: host gone, connection
refused, or server shutting down. A timeout counts as UNKNOWN. A primary must be DOWN for 3
checks and at least 5 s before failover. The old primary is fenced read-only if it returns.

**2PC blocking.** A prepared transaction keeps its row locks until it is decided. A coordinator
crash therefore blocks that user's wallet row until recovery runs (about 15 s). The 2PC crash
demo shows this. Saga was not used for the booking core because it gives no isolation between
steps.

**Known limitations (proposal stretch goals not implemented).**

- Live rebalancing to a 4th shard (the hash ring supports it, see the unit test), etcd,
  Prometheus/Grafana, a waiting room and PgBouncer.
- The leader lease lives in Redis, which is not a consensus protocol. If Redis is down, no
  failover or background job runs until it returns.
- With asynchronous replication, a failover can lose the last few committed transactions of the
  dead primary. The verifier detects this. Use `SYNC_STANDBY_NAMES='*'` for zero loss at a
  latency cost.
- Rebuilding a fenced old primary as a replica is manual. For demos, reset with
  `docker compose down -v`.

## Project layout

```
docker-compose.yml        the whole cluster (each container = one node)
infra/postgres/           shard + meta schemas, replication bootstrap scripts
infra/nginx/nginx.conf    gateway: load balancing, rate/connection limits
api/src/
  cluster/                hash rings, shard map, DB nodes (pool + bulkhead + circuit breaker)
  redis/                  inventory cache (Lua), rate limiter, leader lease
  transactions/           Two-Phase Commit + decision log
  services/               users, events/search, holds, bookings, tickets, reports
  jobs/                   failover, hold expiry, 2PC recovery, cache reconciliation (leader only)
  http/                   routes, middleware, admission control
  seed/                   dataset generator (places rows with the same rings)
web/src/                  React UI
tests/k6/                 load, race and rate-limit tests
```

## Troubleshooting

- **Port 8080 or 6379 in use:** change the left side of `ports:` in `docker-compose.yml`.
- **`$'\r': command not found` in a shard log:** a `.sh` file got Windows line endings. `.gitattributes` keeps them LF; re-save as LF.
- **Seed fails or the cluster is in a strange state after demos:** `docker compose down -v`, then `docker compose up -d --build`.
- **Leftover containers from the old Citus version** (`citus-coordinator`, `citus-worker-*`, `db-init`, `nginx`): `docker compose up -d --remove-orphans` removes them.
