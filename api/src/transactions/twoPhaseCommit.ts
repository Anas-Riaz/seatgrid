import { randomUUID } from "node:crypto";
import type { Client } from "../cluster/dbNode.js";
import type { Shard } from "../cluster/shard.js";
import { config } from "../config.js";
import * as txLog from "./txLog.js";

/**
 * Application-level Two-Phase Commit across shards, built on PostgreSQL's
 * PREPARE TRANSACTION (a prepared transaction is stored durably in the WAL and
 * survives a crash until someone commits or rolls it back by its global id).
 *
 *   Phase 1  each participant does its work and PREPAREs (= votes yes)
 *   Decide   log COMMITTING in the meta DB (the commit point) — or ABORT
 *   Phase 2  COMMIT PREPARED (or ROLLBACK PREPARED) on every participant
 *
 * If this coordinator dies at any point, the recovery worker (jobs/txRecovery.ts)
 * finishes the job using the log.
 */

export interface Participant {
  /** Short label, e.g. "seats" or "wallet"; becomes part of the prepared transaction's id. */
  name: string;
  shard: Shard;
  /** The participant's local work. Throwing = voting NO. */
  work: (client: Client) => Promise<void>;
}

/** Points where a demo request can kill the coordinator (see README, "2PC crash demo"). */
export type CrashPoint = "prepare" | "decision";

export const GID_PREFIX = "sg_";

/** Prepared-transaction id on one participant: "<gid>:<participant name>". */
export const participantGid = (gid: string, name: string) => `${gid}:${name}`;
export const globalGidOf = (preparedGid: string) => preparedGid.split(":")[0];

export async function runTwoPhaseCommit(participants: Participant[], crashAfter?: CrashPoint): Promise<string> {
  const gid = `${GID_PREFIX}${randomUUID().replaceAll("-", "")}`;
  await txLog.logPreparing(gid, participants.map((p) => `${p.name}@${p.shard.id}`));

  // ---------------- Phase 1: prepare (in order; later work may depend on earlier results)
  const prepared: Participant[] = [];
  try {
    for (const participant of participants) {
      await prepare(gid, participant);
      prepared.push(participant);
    }
  } catch (err) {
    await abort(gid, prepared);
    throw err;
  }
  crashIfRequested(crashAfter, "prepare");

  // ---------------- Decision
  if (!(await txLog.decideCommit(gid))) {
    // Recovery decided ABORT while we were slow. Respect it.
    await abort(gid, prepared);
    throw new Error(`Transaction ${gid} was aborted by recovery`);
  }
  crashIfRequested(crashAfter, "decision");

  // ---------------- Phase 2: commit. The decision is durable, so failures here
  // are retried and, if still failing, finished later by the recovery worker.
  await Promise.all(participants.map((p) => finishWithRetry(p.shard, participantGid(gid, p.name), "COMMIT")));
  await txLog.markFinished(gid, "COMMITTED").catch(() => {});
  return gid;
}

async function prepare(gid: string, participant: Participant): Promise<void> {
  await participant.shard.primary.withClient(async (client) => {
    await client.query("BEGIN");
    await participant.work(client);
    await client.query(`PREPARE TRANSACTION '${participantGid(gid, participant.name)}'`);
  }, "write");
}

async function abort(gid: string, prepared: Participant[]): Promise<void> {
  await txLog.decideAbortUnlessCommitted(gid).catch(() => {});
  for (const p of prepared) {
    // Best effort: anything left behind is rolled back by the recovery worker.
    await finishPrepared(p.shard, participantGid(gid, p.name), "ROLLBACK").catch(() => {});
  }
}

/** COMMIT PREPARED / ROLLBACK PREPARED one participant. Missing gid = already done. */
export async function finishPrepared(shard: Shard, preparedGid: string, action: "COMMIT" | "ROLLBACK"): Promise<void> {
  try {
    await shard.primary.query(`${action} PREPARED '${preparedGid}'`, [], "write");
  } catch (err) {
    const alreadyDone = (err as { code?: string }).code === "42704"; // undefined_object
    if (!alreadyDone) throw err;
  }
}

async function finishWithRetry(shard: Shard, preparedGid: string, action: "COMMIT" | "ROLLBACK"): Promise<void> {
  for (const delayMs of [0, 100, 300, 1_000]) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await finishPrepared(shard, preparedGid, action);
    } catch (err) {
      console.warn(`[2pc] ${action} PREPARED ${preparedGid} failed: ${(err as Error).message}`);
    }
  }
  console.warn(`[2pc] leaving ${preparedGid} to the recovery worker`);
}

function crashIfRequested(requested: CrashPoint | undefined, point: CrashPoint): void {
  if (config.crashInjection && requested === point) {
    console.error(`[2pc] CRASH INJECTION: exiting after ${point}`);
    process.exit(1);
  }
}
