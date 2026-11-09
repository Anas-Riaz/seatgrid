import { cluster } from "../cluster/cluster.js";
import { config } from "../config.js";
import { conflict, notFound, SqlState, sqlState, unauthorized } from "../errors.js";
import { redis, withRedis } from "../redis/redis.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { issueToken } from "./tokens.js";

/**
 * Accounts live on Ring B: hash(username) names exactly ONE owner shard, so
 * checking whether a username exists is O(1) routing plus one primary-key lookup,
 * no matter how many coordinators or shards there are.
 */

const knownUserKey = (username: string) => `user:exists:${username}`;
const claimKey = (username: string) => `user:claim:${username}`;
const CLAIM_TTL_MS = 10_000;

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const known = await withRedis(() => redis.exists(knownUserKey(username)), 0);
  if (known) return false;

  const [row] = await cluster.shardForUser(username).primary.query("SELECT 1 FROM users WHERE username = $1", [username]);
  if (row) await withRedis(() => redis.set(knownUserKey(username), 1), null);
  return !row;
}

/**
 * Registration with no coordinator-to-coordinator communication:
 *   1. Redis rejects names it already knows.
 *   2. SET NX claims the name, so two simultaneous requests (even on different
 *      coordinators) cannot both proceed.
 *   3. The INSERT on the owner shard is the final judge: its primary key settles
 *      any remaining race (e.g. when Redis is down). The wallet is created in the
 *      same local transaction.
 */
export async function register(username: string, email: string, password: string) {
  if (!(await isUsernameAvailable(username))) throw conflict("Username is already taken");

  const claimed = await withRedis(
    async () => (await redis.set(claimKey(username), config.coordinatorId, "PX", CLAIM_TTL_MS, "NX")) === "OK",
    true, // Redis down: skip the claim, the primary key still protects us
  );
  if (!claimed) throw conflict("Username is being registered by someone else");

  try {
    const passwordHash = await hashPassword(password);
    await cluster.shardForUser(username).primary.transaction(async (client) => {
      await client.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)", [
        username,
        email,
        passwordHash,
      ]);
      await client.query("INSERT INTO wallets (username, balance, opening_balance) VALUES ($1, $2, $2)", [
        username,
        config.wallet.openingBalance,
      ]);
    });
  } catch (err) {
    if (sqlState(err) === SqlState.uniqueViolation) throw conflict("Username is already taken");
    throw err;
  } finally {
    await withRedis(() => redis.del(claimKey(username)), 0);
  }

  await withRedis(() => redis.set(knownUserKey(username), 1), null);
  return { username, token: issueToken(username, false) };
}

export async function login(username: string, password: string) {
  // Primary, not replica: a user who just registered must be able to log in.
  const [user] = await cluster
    .shardForUser(username)
    .primary.query<{ password_hash: string; is_admin: boolean }>(
      "SELECT password_hash, is_admin FROM users WHERE username = $1",
      [username],
    );
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw unauthorized("Wrong username or password");
  }
  return { username, isAdmin: user.is_admin, token: issueToken(username, user.is_admin) };
}

export async function getProfile(username: string) {
  const [profile] = await cluster
    .shardForUser(username)
    .primary.query(
      `SELECT u.username, u.email, u.is_admin, w.balance
       FROM users u JOIN wallets w USING (username)
       WHERE u.username = $1`,
      [username],
    );
  if (!profile) throw notFound("User not found");
  return { ...profile, shard: cluster.shardForUser(username).id };
}
