import { cluster } from "../cluster/cluster.js";
import { config } from "../config.js";
import { scatter } from "../services/scatterGather.js";
import { finishPrepared, GID_PREFIX, globalGidOf } from "../transactions/twoPhaseCommit.js";
import * as txLog from "../transactions/txLog.js";

/**
 * 2PC recovery worker. Finds prepared transactions that nobody finished
 * (coordinator crashed, participant was unreachable) and completes them
 * according to the decision log:
 *
 *   no decision logged  -> ROLLBACK PREPARED (presumed abort)
 *   COMMITTING          -> COMMIT PREPARED
 */
export async function recoverTransactions(): Promise<void> {
  for (const shard of cluster.all()) {
    try {
      const orphans = await shard.primary.query<{ gid: string }>(
        `SELECT gid FROM pg_prepared_xacts
         WHERE database = current_database()
           AND gid LIKE $1
           AND prepared < now() - make_interval(secs => $2)`,
        [`${GID_PREFIX}%`, config.jobs.txOrphanAfterSeconds],
      );

      for (const { gid } of orphans) {
        const decision = await txLog.decideAbortUnlessCommitted(globalGidOf(gid));
        const action = decision === "COMMITTING" || decision === "COMMITTED" ? "COMMIT" : "ROLLBACK";
        await finishPrepared(shard, gid, action);
        console.log(`[2pc-recovery] shard ${shard.id}: ${action} PREPARED ${gid}`);
      }
    } catch (err) {
      console.warn(`[2pc-recovery] shard ${shard.id}: ${(err as Error).message}`);
    }
  }

  // Close out COMMITTING transactions once no participant still holds them prepared.
  for (const gid of await txLog.staleCommitting(config.jobs.txOrphanAfterSeconds)) {
    const leftovers = await scatter((shard) =>
      shard.primary.query("SELECT 1 FROM pg_prepared_xacts WHERE gid LIKE $1", [`${gid}:%`]),
    );
    if (leftovers.flat().length === 0) await txLog.markFinished(gid, "COMMITTED");
  }
}
