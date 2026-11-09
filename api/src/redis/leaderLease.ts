import { config } from "../config.js";
import { luaScript, redis, withRedis } from "./redis.js";

const LEASE_KEY = "lease:leader";

// Extend the lease only if this coordinator still owns it.
const renewScript = luaScript(`
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`);

/**
 * Leader lease: exactly one coordinator at a time runs failover and background
 * jobs. The holder renews the lease well before it expires; if it dies, the
 * lease times out and another coordinator takes over.
 *
 * Note: this is a lease, not a consensus protocol (see README, "Redis lease vs Raft").
 */
class LeaderLease {
  private leader = false;

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    void this.tick();
    setInterval(() => void this.tick(), config.lease.renewEveryMs).unref();
  }

  private async tick(): Promise<void> {
    const me = config.coordinatorId;
    const ttl = config.lease.ttlMs;
    const wasLeader = this.leader;

    this.leader = await withRedis(async () => {
      if (this.leader) return (await renewScript([LEASE_KEY], [me, ttl])) === 1;
      return (await redis.set(LEASE_KEY, me, "PX", ttl, "NX")) === "OK";
    }, false);

    if (this.leader !== wasLeader) {
      console.log(this.leader ? "[lease] this coordinator is now the leader" : "[lease] leadership lost");
    }
  }
}

export const leaderLease = new LeaderLease();

export const currentLeader = () => withRedis(() => redis.get(LEASE_KEY), null);
