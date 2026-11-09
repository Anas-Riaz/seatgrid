import { config } from "../config.js";
import { meta } from "../cluster/meta.js";

/**
 * Durable 2PC decision log in the meta database.
 *
 * The decision is a single conditional row update (PREPARING -> COMMITTING or
 * PREPARING -> ABORTED). Because only one of the two can win, the coordinator
 * and the recovery worker can never reach different decisions for the same
 * transaction, even if a "dead" coordinator turns out to be merely slow.
 */
export type TxStatus = "PREPARING" | "COMMITTING" | "COMMITTED" | "ABORTED";

export async function logPreparing(gid: string, participants: string[]): Promise<void> {
  await meta.query("INSERT INTO tx_log (gid, status, participants, coordinator) VALUES ($1, 'PREPARING', $2, $3)", [
    gid,
    participants,
    config.coordinatorId,
  ]);
}

/** The commit point. Returns false if recovery already aborted this transaction. */
export async function decideCommit(gid: string): Promise<boolean> {
  const result = await meta.query(
    "UPDATE tx_log SET status = 'COMMITTING', updated_at = now() WHERE gid = $1 AND status = 'PREPARING'",
    [gid],
  );
  return result.rowCount === 1;
}

/** Abort unless a COMMIT decision was already made. Returns the final decision. */
export async function decideAbortUnlessCommitted(gid: string): Promise<TxStatus> {
  // A gid with no log row at all can only come from a coordinator that crashed
  // before logging: insert ABORTED (presumed abort).
  await meta.query(
    `INSERT INTO tx_log (gid, status, participants, coordinator) VALUES ($1, 'ABORTED', '{}', $2)
     ON CONFLICT (gid) DO UPDATE SET status = 'ABORTED', updated_at = now()
     WHERE tx_log.status = 'PREPARING'`,
    [gid, config.coordinatorId],
  );
  const { rows } = await meta.query<{ status: TxStatus }>("SELECT status FROM tx_log WHERE gid = $1", [gid]);
  return rows[0].status;
}

export async function markFinished(gid: string, status: "COMMITTED" | "ABORTED"): Promise<void> {
  await meta.query("UPDATE tx_log SET status = $2, updated_at = now() WHERE gid = $1", [gid, status]);
}

export async function recentTransactions(limit: number) {
  const { rows } = await meta.query(
    "SELECT gid, status, participants, coordinator, created_at, updated_at FROM tx_log ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

/** COMMITTING transactions older than `seconds` (phase 2 may not have finished everywhere). */
export async function staleCommitting(seconds: number): Promise<string[]> {
  const { rows } = await meta.query<{ gid: string }>(
    "SELECT gid FROM tx_log WHERE status = 'COMMITTING' AND updated_at < now() - make_interval(secs => $1)",
    [seconds],
  );
  return rows.map((r) => r.gid);
}
