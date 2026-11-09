-- Meta database: tiny control data, never on the hot read path.

-- Which physical nodes serve each logical shard. Rows are written by the seed job
-- and changed by the failover manager; coordinators poll this table every second.
CREATE TABLE shard_map (
  shard_id     INT PRIMARY KEY,
  primary_host TEXT NOT NULL,        -- "host:port"
  replica_host TEXT,                 -- NULL after a failover until a new replica is built
  fenced_host  TEXT,                 -- old primary that must never take writes again
  version      INT NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two-Phase Commit decision log.
--   PREPARING  -> participants are being prepared (no decision yet: presumed abort)
--   COMMITTING -> decision is COMMIT; recovery must finish it on every participant
--   COMMITTED / ABORTED -> final
CREATE TABLE tx_log (
  gid          TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('PREPARING', 'COMMITTING', 'COMMITTED', 'ABORTED')),
  participants TEXT[] NOT NULL,      -- e.g. {seats@1, wallet@3}
  coordinator  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tx_log_open ON tx_log (created_at) WHERE status IN ('PREPARING', 'COMMITTING');
