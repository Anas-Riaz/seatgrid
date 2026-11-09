import { isNodeFailure } from "../errors.js";
import type { DbNode, QueryParams } from "./dbNode.js";

/**
 * A logical shard: one primary that takes all writes, plus an optional
 * hot-standby replica that follows it through streaming replication.
 */
export class Shard {
  constructor(
    readonly id: number,
    readonly primary: DbNode,
    readonly replica: DbNode | null,
  ) {}

  /**
   * Stale-tolerant read (search, history, reports): use the replica to keep load
   * off the primary, and fall back to the primary if the replica is down.
   */
  async read<Row extends object = any>(sql: string, params: QueryParams = []): Promise<Row[]> {
    if (this.replica) {
      try {
        return await this.replica.query<Row>(sql, params, "read");
      } catch (err) {
        if (!isNodeFailure(err)) throw err;
      }
    }
    return this.primary.query<Row>(sql, params, "read");
  }
}
