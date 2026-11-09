import { cluster } from "../cluster/cluster.js";
import type { Shard } from "../cluster/shard.js";

/** Run the same query on every shard in parallel and return all partial results. */
export async function scatter<T>(fn: (shard: Shard) => Promise<T>): Promise<T[]> {
  return Promise.all(cluster.all().map(fn));
}

/** Read `sql` from every shard (replica preferred) and concatenate the rows. */
export async function scatterRead<Row extends object>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const parts = await scatter((shard) => shard.read<Row>(sql, params));
  return parts.flat();
}

/**
 * K-way merge of lists that are each already sorted by `compare`, keeping the
 * first `limit` items. Used for distributed sorting: every shard returns its own
 * top K, and the coordinator merges them.
 */
export function mergeSorted<T>(lists: T[][], compare: (a: T, b: T) => number, limit: number): T[] {
  const positions = lists.map(() => 0);
  const merged: T[] = [];
  while (merged.length < limit) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      const candidate = lists[i][positions[i]];
      if (candidate === undefined) continue;
      if (best === -1 || compare(candidate, lists[best][positions[best]]) < 0) best = i;
    }
    if (best === -1) break; // every list is exhausted
    merged.push(lists[best][positions[best]++]);
  }
  return merged;
}
