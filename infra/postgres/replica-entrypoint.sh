#!/usr/bin/env bash
# Starts a hot-standby replica of $PRIMARY_HOST.
# On first boot the data directory is empty, so it is cloned from the primary with
# pg_basebackup; -R writes the settings that make this node follow the primary.
set -euo pipefail

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Cloning primary $PRIMARY_HOST ..."
  until PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
      --host="$PRIMARY_HOST" --username=replicator \
      --pgdata="$PGDATA" --write-recovery-conf --wal-method=stream; do
    echo "Primary not ready yet, retrying in 2s"
    rm -rf "${PGDATA:?}"/*
    sleep 2
  done
  chmod 700 "$PGDATA"
fi

exec postgres "$@"
