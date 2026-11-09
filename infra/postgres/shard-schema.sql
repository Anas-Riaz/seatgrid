-- Schema for every shard primary (replicas receive it through streaming replication).
-- Every shard has the same tables; the hash rings decide which rows live where.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram indexes for partial-word search

-- ===================== Reference data: identical copy on every shard =====================

CREATE TABLE ticket_classes (
  class_id         SMALLINT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,          -- Premium, General, Enclosure
  price_multiplier NUMERIC(4, 2) NOT NULL
);

CREATE TABLE venues (
  venue_id INT PRIMARY KEY,
  name     TEXT NOT NULL,
  city     TEXT NOT NULL
);

-- Every stadium uses the same 20-section layout.
CREATE TABLE sections (
  section_id SMALLINT PRIMARY KEY,
  name       TEXT NOT NULL,
  class_id   SMALLINT NOT NULL REFERENCES ticket_classes,
  seat_count INT NOT NULL
);

CREATE TABLE events (
  event_id      INT PRIMARY KEY,
  title         TEXT NOT NULL,
  tournament    TEXT NOT NULL,
  home_team     TEXT NOT NULL,
  away_team     TEXT NOT NULL,
  venue_id      INT NOT NULL REFERENCES venues,
  start_time    TIMESTAMPTZ NOT NULL,
  base_price    NUMERIC(10, 2) NOT NULL,
  -- Filled by the seed from title, teams, venue and city.
  search_text   TEXT NOT NULL,
  search_vector TSVECTOR NOT NULL
);

CREATE INDEX events_search_vector ON events USING GIN (search_vector);
CREATE INDEX events_search_trgm   ON events USING GIN (search_text gin_trgm_ops);
CREATE INDEX events_start_time    ON events (start_time);
CREATE INDEX events_base_price    ON events (base_price);

-- ===================== Ring A: inventory, placed by hash(event_id, section_id) =====================

CREATE TABLE seats (
  event_id   INT NOT NULL,
  section_id SMALLINT NOT NULL,
  seat_no    INT NOT NULL,
  class_id   SMALLINT NOT NULL,
  price      NUMERIC(10, 2) NOT NULL,
  status     TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
  hold_id    UUID,
  held_by    TEXT,
  held_until TIMESTAMPTZ,
  PRIMARY KEY (event_id, section_id, seat_no),
  CHECK ((status = 'HELD') = (hold_id IS NOT NULL))
);

CREATE INDEX seats_available  ON seats (event_id, section_id, seat_no) WHERE status = 'AVAILABLE';
CREATE INDEX seats_held_until ON seats (held_until) WHERE status = 'HELD';

-- One row per booking request. The primary key makes retries idempotent.
CREATE TABLE orders (
  idempotency_key TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  event_id        INT NOT NULL,
  section_id      SMALLINT NOT NULL,
  total           NUMERIC(12, 2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per ticket. UNIQUE(event, section, seat) is the last line of defence
-- against double booking, whatever the application does.
CREATE TABLE bookings (
  ticket_no       TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL REFERENCES orders,
  event_id        INT NOT NULL,
  section_id      SMALLINT NOT NULL,
  seat_no         INT NOT NULL,
  class_id        SMALLINT NOT NULL,
  username        TEXT NOT NULL,
  price           NUMERIC(10, 2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, section_id, seat_no)
);

CREATE INDEX bookings_idempotency_key ON bookings (idempotency_key);
CREATE INDEX bookings_username        ON bookings (username text_pattern_ops, created_at DESC);

-- ===================== Ring B: accounts, placed by hash(username) =====================

CREATE TABLE users (
  username      TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  username        TEXT PRIMARY KEY REFERENCES users,
  balance         NUMERIC(12, 2) NOT NULL CHECK (balance >= 0),
  opening_balance NUMERIC(12, 2) NOT NULL
);

-- Global secondary index: "my tickets" is answered from the user's own shard.
CREATE TABLE user_tickets (
  username   TEXT NOT NULL REFERENCES users,
  ticket_no  TEXT NOT NULL,
  event_id   INT NOT NULL,
  section_id SMALLINT NOT NULL,
  seat_no    INT NOT NULL,
  price      NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (username, ticket_no)
);
