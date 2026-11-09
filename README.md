# SeatGrid — Cricket Ticket Booking on a Distributed Database

> CS 606 Distributed Database Systems — Syed Anas Riaz (B20102156)

SeatGrid is a PSL/IPL-style cricket ticket booking system. It is built on a **hand-built distributed
PostgreSQL cluster**: three shards, each a primary + streaming replica, with three stateless API
coordinators in front.

The point of the project is the hard part of ticketing: **thousands of fans trying to buy the same
seats at the same second**. No seat may be sold twice, and the system must keep working when a
database node dies.

## Features

| Area | What it does |
|---|---|
| **Sharding** | Data is split over 3 PostgreSQL shards using **consistent hashing** (MD5, 128 virtual nodes per shard). Seats are placed by `(event, section)` and users by `username`. |
| **Replication** | Every shard has a primary and an asynchronous **streaming replica**. Reads go to the replica, writes to the primary. |
| **Distributed transactions** | A booking touches two shards (the seat's shard and the buyer's wallet shard), so it uses **Two-Phase Commit** (`PREPARE TRANSACTION` / `COMMIT PREPARED`) with a durable decision log and crash recovery. |
| **No double booking** | Three independent layers: an atomic Redis Lua pre-check, a compare-and-set `UPDATE` on the seat row, and a `UNIQUE` constraint on bookings. |
| **Automatic failover** | When a primary dies, its replica is promoted with `pg_promote()` in about 6–9 s, the shard map is versioned and the old primary is fenced read-only. |
| **Caching** | Redis keeps seat counters, seat bitmaps, holds and a short search cache. |
| **Overload protection** | Token-bucket rate limits, admission control, bulkheads and circuit breakers. A flash sale gets clean "busy" answers instead of crashing the system. |
| **Distributed queries** | Scatter-gather search, partial aggregation for sales reports, top-K with a K-way merge. |
| **Testing** | k6 load tests (a 500-user race for one seat, a flash sale, a mixed workload, rate limiting), a consistency verifier and failure demos. |

**Tech stack:** PostgreSQL 16 · Redis 7 · Node.js 22 + Express 5 + TypeScript · React + Vite ·
NGINX · Docker Compose · k6

---

## Architecture

Each box is a separate Docker container (14 in total), so each one behaves like a separate machine.

```
 Browser ─► gateway (NGINX :8080)   load balancer, rate + connection limits
               ├─► web    React UI
               └─► api ×3 stateless coordinators: hash-ring router, scatter-gather query engine,
                     │     2PC transaction manager, cache manager, admission control.
                     │     The one holding the Redis lease also runs failover + background jobs.
                     ├─► redis   seat counters, seat bitmaps, holds, rate limits, leader lease
                     ├─► meta    versioned shard map + 2PC decision log (tx_log)
                     └─► shard1-a ⇄ shard1-b   shard2-a ⇄ shard2-b   shard3-a ⇄ shard3-b
                          (primary)  (replica)   asynchronous streaming replication per shard
```

| Data | Where it lives | Why |
|---|---|---|
| `events`, `venues`, `sections`, `ticket_classes` | copied to **every** shard | small, read-heavy, joined with everything |
| `seats`, `orders`, `bookings` | **Ring A**: `hash(event, section)` | one hot match is spread over all shards; seats and their bookings stay together |
| `users`, `wallets`, `user_tickets` | **Ring B**: `hash(username)` | constant-time username check; "my tickets" reads one shard |
| `shard_map`, `tx_log` | meta database | small control data |

Ticket numbers encode where they live. For example, `E017-S05-0123-9F2A` is event 17, section 5,
seat 123, so a ticket lookup goes straight to the right shard.

### What happens when you buy a ticket

| Step | What happens | Where |
|---|---|---|
| 1 | Admission control, rate limits, input validation | NGINX, coordinator, Redis |
| 2 | Atomic Lua pre-check: are the seats free? If not, refuse at once without touching PostgreSQL | Redis |
| 3 | **Hold** the seats for 5 minutes: compare-and-set `AVAILABLE → HELD` (`FOR UPDATE SKIP LOCKED` for best-available) | seat shard primary |
| 4 | **2PC phase 1**: the seat shard books the seats and writes tickets; the user shard debits the wallet. Both run `PREPARE TRANSACTION` | seat shard + user shard |
| 5 | Write `COMMITTING` to `tx_log` (the commit point), then `COMMIT PREPARED` on both shards | meta, both shards |
| 6 | A retry with the same idempotency key returns the original tickets, never a second charge | `orders` primary key |

---

## Getting started

### Prerequisites

- **Docker Desktop** (on Windows, use the WSL 2 backend). Give it at least 4 GB of RAM, and 8 GB if
  you can. On Windows, set this in `%UserProfile%\.wslconfig` under `[wsl2]` with `memory=8GB`.
- **Git**, to clone the project.
- *Optional:* **Node.js 22**, only needed for unit tests and UI development.
- *Optional:* VS Code with the **REST Client**, **PostgreSQL** and **Docker** extensions.

You do **not** need PostgreSQL, Redis or k6 installed. They all run inside Docker.

### 1. Clone and configure

```bash
git clone <this-repo-url> seatgrid
cd seatgrid
cp .env.example .env        # Windows PowerShell / cmd: copy .env.example .env
```

`.env` controls the dataset size. The default is the full proposal scale: 1,000,000 users, 100
matches and 2,000,000 seats, which takes about 3 minutes to seed. **For a quick first run**, edit
`.env`:

```ini
SEED_USERS=20000
SEED_EVENTS=20
```

### 2. Start the cluster

```bash
docker compose up -d --build
docker compose logs -f seed      # wait for "Seed finished", then Ctrl+C
```

The first build downloads images and takes a few minutes. After that, startups are fast.

### 3. Open it

| What | Where |
|---|---|
| Web UI | **http://localhost:8080** (log in as `demo` / `password123`) |
| Cluster status (shard map, replication lag, leader) | http://localhost:8080/api/cluster |
| Every API call, ready to send from VS Code | [requests.http](requests.http) (needs the REST Client extension) |

**Seeded accounts** all use the password `password123`, and every wallet starts with PKR 100,000:

| Account | Use |
|---|---|
| `demo` | normal user for trying the UI |
| `admin` | admin reports (`/api/admin/...`) |
| `user0000001` … `user1000000` | bulk users (used by the load tests) |

### Docker cheat sheet

| Command | What it does |
|---|---|
| `docker compose up -d --build` | build and start everything |
| `docker compose ps` | list containers and their health |
| `docker compose logs -f api` | follow the coordinator logs (Ctrl+C to stop following) |
| `docker stop shard1-a` / `docker start shard1-a` | switch one node off or on |
| `docker compose down` | stop everything (data is kept) |
| `docker compose down -v` | stop everything and **delete all data** (fresh start; the seed runs again) |

### Connecting to the databases

Use pgAdmin, DBeaver or the VS Code PostgreSQL extension with host `localhost`, user `postgres` and
password `postgres`:

| Node | Port | Database |
|---|---|---|
| meta | 5500 | `meta` |
| shard N primary (`shardN-a`) | 55N1: 5511, 5521, 5531 | `seatgrid` |
| shard N replica (`shardN-b`) | 55N2: 5512, 5522, 5532 (read-only) | `seatgrid` |

You can also use a terminal: `docker exec -it shard1-a psql -U postgres -d seatgrid`

---

## Testing

All k6 commands run k6 **inside Docker**, so nothing needs installing. They work as written in
PowerShell, cmd, macOS and Linux. In **Git Bash** on Windows, put `MSYS_NO_PATHCONV=1` in front of
them so the `/tests/...` path is not rewritten.

### Unit tests

The hash ring tests check that hashing is deterministic, that load is balanced, and that about
1/(N+1) of keys move when a shard is added.

```bash
cd api
npm install
npm test
```

### Race test: 500 users, one seat

This is the main correctness test. 500 different users log in, then all of them try to hold **the
same seat at the same moment** and pay for it.

```bash
docker compose --profile tools run --rm k6 run /tests/race-one-seat.js
```

Options: `-e USERS=1000 -e EVENT=5 -e SECTION=3 -e SEAT=50`. Without `SEAT`, a random seat is
picked. Pick a new seat each run, because a seat that is already sold correctly gets 0 winners.

What a passing run looks like:

```
500 users racing for event 2, section 7, seat 131
✓ consistency verifier passes
✓ 'count==1' count=1           ← exactly ONE booking
refused_seat_taken....: 494    ← refused with 409 "seat already taken"
refused_busy..........: 5      ← shed by overload protection (503), also a clean refusal
```

A ✗ on the latency threshold (`http_req_duration`) is a speed target, not a correctness failure. A
small laptop may not meet it.

To check the result yourself:

- In the UI, open the same match and section. The seat is shown as taken.
- In the seat's shard, `SELECT * FROM bookings WHERE event_id=2 AND section_id=7 AND seat_no=131;`
  returns **exactly one row**.
- `docker compose logs gateway` shows the requests spread over the three coordinators.

**By hand:** open the UI in a normal window and in a private/incognito window. Log in as two
different users (for example `demo` and `user0000001`), pick the same seat in both, and click
**Hold** in both. One window gets the seat; the other gets "Seat already taken".

### Load tests

```bash
# Flash sale: 2,000 users, 5,000 seats, 60 s ramp → no crash, excess refused, zero oversell
docker compose --profile tools run --rm k6 run /tests/flash-sale.js
docker compose --profile tools run --rm k6 run -e VUS=300 /tests/flash-sale.js   # smaller machines

# Mixed workload: 80% search, 15% seat map, 5% booking
docker compose --profile tools run --rm k6 run /tests/mixed-workload.js

# One user hammering the API → 429 Too Many Requests with Retry-After
docker compose --profile tools run --rm k6 run /tests/rate-limit.js
```

### Consistency verifier

Every k6 test that books tickets runs the verifier at the end. You can also run it any time with
`GET /api/admin/verify` (log in as `admin`; it is in [requests.http](requests.http)). It checks
that:

- no seat is booked twice
- tickets equal booked seats on every shard
- `user_tickets` (the user-side index) matches `bookings`
- wallet debits equal ticket revenue
- the Redis counters match the database

### Failure demos

Run these while the UI or a load test is running, and watch `docker compose logs -f api` in
another terminal.

| Demo | Command | What you should see |
|---|---|---|
| Primary crash → failover | `docker stop shard1-a` | the logs show `promoted shard1-b … (6s after it went down)`; `/api/cluster` lists the new primary; other shards are unaffected. After `docker start shard1-a`, the old primary comes back **fenced** (read-only). |
| Replica down | `docker stop shard2-b` | reads fall back to `shard2-a`; nothing fails |
| Coordinator crash | `docker compose ps` to find an api container, then `docker kill <name>` | NGINX routes around it; if it held the leader lease, another coordinator takes over within ~5 s |
| Redis down | `docker stop redis` | search, seat maps and bookings keep working from PostgreSQL (slower); after `docker start redis` the cache is rebuilt |
| Network partition | `docker network disconnect <project>_default shard3-a` | the node's requests fail fast (circuit breaker) and the monitor fails over to `shard3-b` |
| 2PC: crash before the decision | send a booking with header `X-Crash-After: prepare` | the coordinator exits; ~15 s later recovery finds no decision and runs `ROLLBACK PREPARED` (presumed abort) |
| 2PC: crash after the decision | header `X-Crash-After: decision` | the log says `COMMITTING`; recovery runs `COMMIT PREPARED` on both shards, and the tickets and wallet debit appear |

`<project>` is the folder name of your clone (see `docker network ls`). Watch the 2PC demos at
`GET /api/admin/transactions`. Crash injection is enabled by `CRASH_INJECTION=on` in
`docker-compose.yml` and is for development only.

After failure demos, reset to a clean cluster with `docker compose down -v`, then
`docker compose up -d --build`.

### Experiments

- **Scale-out, coordinators:** set `API_REPLICAS=1` and then `3` in `.env`, run
  `docker compose up -d`, then run `mixed-workload.js` and compare.
- **Scale-out, shards:** set `SHARD_COUNT=1` and then `3` in `.env`, run `docker compose down -v`,
  then `docker compose up -d --build`, then run `mixed-workload.js`.
- **Sync vs async replication (PACELC):** set `SYNC_STANDBY_NAMES='*'` in `.env`, rebuild with
  `down -v`, and compare booking latency and replication lag on `/api/cluster`.
- **Query plans:** inside `psql`, run
  `EXPLAIN ANALYZE SELECT * FROM events WHERE search_vector @@ websearch_to_tsquery('simple','karachi');`

---

## Results

These were measured on a 4-core Windows laptop. Docker had 4 vCPUs and 4 GB, shared by all 14
containers, the load generator and Windows. The dataset was the full proposal scale.

| Measure | Target | Result |
|---|---|---|
| Double bookings after any test | 0 | **0** (the verifier passes after the race, flash-sale, failover, Redis-down and 2PC-crash tests) |
| 500 users racing for one seat | 1 booking | **exactly 1**; 494 refused "seat taken", the rest shed with 503 |
| Flash sale, 2,000 users | no crash | **no crash**; excess refused with 409/429/503; zero oversell |
| Failover after `docker stop` | < 30 s | **6–9 s**; only that shard's writes paused |
| Search, single user | < 300 ms | ~100–200 ms |
| p95 latency at 2,000 users | search < 300 ms, booking < 1.5 s | **not met on this hardware** (CPU-bound; even `/health` through NGINX peaks at ~270 req/s) |

---

## API reference

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | coordinator id, whether it is the leader, shard-map version |
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
| GET | `/api/tickets/:ticketNo` | look up a ticket by its number |
| GET | `/api/admin/sales`, `/api/admin/bookings?username=`, `/api/admin/verify`, `/api/admin/transactions` | admin only |

---

## Project layout

```
docker-compose.yml        the whole cluster (each container = one node)
.env.example              settings: dataset size, replicas, shard count, sync replication
requests.http             ready-to-send API examples (VS Code REST Client)
infra/postgres/           shard + meta schemas, replication bootstrap scripts
infra/nginx/nginx.conf    gateway: load balancing, rate and connection limits
api/src/
  cluster/                hash rings, shard map, DB nodes (pool + bulkhead + circuit breaker)
  redis/                  inventory cache (Lua), rate limiter, leader lease
  transactions/           Two-Phase Commit + decision log
  services/               users, events/search, holds, bookings, tickets, reports
  jobs/                   failover, hold expiry, 2PC recovery, cache reconciliation (leader only)
  http/                   routes, middleware, admission control
  seed/                   dataset generator (places rows using the same hash rings)
web/src/                  React UI
tests/k6/                 race, flash-sale, mixed-workload and rate-limit tests
```

### Where each proposal section lives in the code

| Proposal | Code |
|---|---|
| Consistent hashing, 128 virtual nodes, Rings A and B (§6.2) | [hashRing.ts](api/src/cluster/hashRing.ts), [cluster.ts](api/src/cluster/cluster.ts) |
| Primary + replica, replica reads with primary fallback (§6.3) | [shard.ts](api/src/cluster/shard.ts), [infra/postgres/](infra/postgres) |
| Failover: health monitor, `pg_promote()`, shard-map version, fencing (§6.3) | [failover.ts](api/src/jobs/failover.ts) |
| Leader lease (§5) | [leaderLease.ts](api/src/redis/leaderLease.ts) |
| Registration, constant-time username check (§7.1) | [users.ts](api/src/services/users.ts) |
| Holds, three-layer protection (§7.2, §8.1) | [holds.ts](api/src/services/holds.ts), [inventoryCache.ts](api/src/redis/inventoryCache.ts) |
| Two-Phase Commit + durable log, recovery (§8.2) | [twoPhaseCommit.ts](api/src/transactions/twoPhaseCommit.ts), [txLog.ts](api/src/transactions/txLog.ts), [txRecovery.ts](api/src/jobs/txRecovery.ts) |
| Booking flow, idempotency | [bookings.ts](api/src/services/bookings.ts) |
| Search/sort (full-text + trigram), ticket lookup, my tickets (§7.3) | [events.ts](api/src/services/events.ts), [tickets.ts](api/src/services/tickets.ts) |
| Partial aggregation, scatter-gather top-K + K-way merge (§7.3) | [reports.ts](api/src/services/reports.ts), [scatterGather.ts](api/src/services/scatterGather.ts) |
| Redis caching (§9.1) | [inventoryCache.ts](api/src/redis/inventoryCache.ts), [scheduler.ts](api/src/jobs/scheduler.ts) |
| Rate limiting, pools, timeouts, circuit breakers, load shedding (§9.2) | [rateLimiter.ts](api/src/redis/rateLimiter.ts), [dbNode.ts](api/src/cluster/dbNode.ts), [bulkhead.ts](api/src/cluster/bulkhead.ts), [circuitBreaker.ts](api/src/cluster/circuitBreaker.ts), [admissionControl.ts](api/src/http/admissionControl.ts), [nginx.conf](infra/nginx/nginx.conf) |
| Consistency verifier (§11) | `verifyConsistency` in [reports.ts](api/src/services/reports.ts) |
| Seed generator (§4) | [api/src/seed/](api/src/seed) |
| Load tests (§11) | [tests/k6/](tests/k6) |

---

## Design notes

**CAP / PACELC.** The system makes a different choice for different data:

- **Bookings, wallets and holds** are **CP** (PC/EC in PACELC). They always use the shard primary. If
  it is unreachable, the request is refused with a fast 503 rather than guessed.
- **Search, catalog and history** lean **AP** (PA/EL). They read replicas and a 2-second cache, so
  they may be slightly stale.

**Failover safety.** Promoting a replica while the old primary is only *busy* would lose its latest
asynchronously replicated transactions. So only definite failures count as DOWN: host gone,
connection refused, or server shutting down. A timeout counts as "unknown". A primary must be DOWN
for 3 checks and at least 5 s before failover, and it is fenced read-only if it comes back.

**2PC blocking.** A prepared transaction holds its row locks until it is decided. If a coordinator
crashes, that user's wallet row stays locked until recovery runs, about 15 s later. Sagas were not
used for bookings because they give no isolation between steps.

**Known limitations.**

- **Not implemented** (proposal stretch goals):
  - live rebalancing to a 4th shard (the hash ring supports it; see the unit test)
  - etcd
  - Prometheus/Grafana
  - a waiting room
  - PgBouncer
- **Leader lease:** it lives in Redis, which is not a consensus system. While Redis is down, no
  failover or background job runs.
- **Replication:** with asynchronous replication, a failover can lose the dead primary's last few
  transactions. The verifier detects this. Use `SYNC_STANDBY_NAMES='*'` for zero loss at a latency
  cost.
- **Fenced primaries:** rebuilding a fenced old primary as a replica is manual. For demos, reset
  with `docker compose down -v`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 8080, 6379 or 55xx already in use | change the left-hand number of `ports:` in `docker-compose.yml` |
| `$'\r': command not found` in a shard log | a `.sh` file got Windows line endings. `.gitattributes` keeps them LF; re-clone or re-save the file as LF |
| The seed fails, or the cluster is in a strange state after demos | `docker compose down -v`, then `docker compose up -d --build` |
| Containers keep restarting, or everything is very slow | give Docker more memory, or use the small dataset (`SEED_USERS=20000`, `SEED_EVENTS=20`) |
| A k6 command fails with a path error in Git Bash | put `MSYS_NO_PATHCONV=1` in front of it |
