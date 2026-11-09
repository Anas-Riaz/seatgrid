#!/usr/bin/env bash
# Runs once when a shard primary is first initialised (docker-entrypoint-initdb.d).
# Creates the role replicas use for streaming replication and allows it in pg_hba.conf.
# (The postgres entrypoint sources this file, so it inherits its "exit on error" setting.)

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
SQL

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
