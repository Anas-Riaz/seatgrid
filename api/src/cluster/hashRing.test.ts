import { test } from "node:test";
import assert from "node:assert/strict";
import { HashRing } from "./hashRing.js";

const keys = Array.from({ length: 30_000 }, (_, i) => `key-${i}`);

test("every coordinator builds the same ring", () => {
  const a = new HashRing("A", [1, 2, 3], 128);
  const b = new HashRing("A", [3, 1, 2], 128);
  for (const key of keys.slice(0, 1000)) assert.equal(a.shardFor(key), b.shardFor(key));
});

test("keys are spread roughly evenly", () => {
  const ring = new HashRing("A", [1, 2, 3], 128);
  const counts = new Map<number, number>();
  for (const key of keys) counts.set(ring.shardFor(key), (counts.get(ring.shardFor(key)) ?? 0) + 1);
  for (const count of counts.values()) {
    assert.ok(count > keys.length * 0.25 && count < keys.length * 0.42, `unbalanced: ${count}`);
  }
});

test("adding a fourth shard moves about a quarter of the keys, all to the new shard", () => {
  const before = new HashRing("A", [1, 2, 3], 128);
  const after = new HashRing("A", [1, 2, 3, 4], 128);
  let moved = 0;
  for (const key of keys) {
    if (before.shardFor(key) !== after.shardFor(key)) {
      moved++;
      assert.equal(after.shardFor(key), 4);
    }
  }
  const share = moved / keys.length;
  assert.ok(share > 0.18 && share < 0.32, `moved ${share}`);
});
