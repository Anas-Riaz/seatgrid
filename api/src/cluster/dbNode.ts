import pg from "pg";
import { config } from "../config.js";
import { isDefinitelyDown, isNodeFailure } from "../errors.js";
import { Bulkhead } from "./bulkhead.js";
import { CircuitBreaker } from "./circuitBreaker.js";

// Return NUMERIC and BIGINT (counts) as JS numbers instead of strings.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));

export type QueryParams = unknown[];
export type Client = pg.PoolClient;
export type Priority = "read" | "write";

/**
 * One PostgreSQL server (a shard primary or replica).
 *
 * Every call goes through three guards:
 *   circuit breaker  -> fail fast if the node keeps failing
 *   bulkhead         -> bounded concurrency + bounded queue (load shedding)
 *   pool + timeouts  -> bounded connections, connect timeout, statement timeout
 */
export class DbNode {
  private readonly pool: pg.Pool;
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Bulkhead;

  constructor(readonly host: string) {
    const [hostname, port = "5432"] = host.split(":");
    this.pool = new pg.Pool({
      host: hostname,
      port: Number(port),
      user: config.shardDatabase.user,
      password: config.shardDatabase.password,
      database: config.shardDatabase.database,
      max: config.node.poolSize,
      connectionTimeoutMillis: config.node.connectTimeoutMs,
      statement_timeout: config.node.statementTimeoutMs,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on("error", (err) => console.warn(`[db ${host}] idle client error: ${err.message}`));
    this.breaker = new CircuitBreaker(host, config.node.breakerFailureThreshold, config.node.breakerOpenMs);
    this.bulkhead = new Bulkhead(host, config.node.poolSize, config.node.queueWaitMs);
  }

  get status() {
    return { host: this.host, circuit: this.breaker.currentState, ...this.bulkhead.stats };
  }

  async query<Row extends pg.QueryResultRow = any>(
    sql: string,
    params: QueryParams = [],
    priority: Priority = "read",
  ): Promise<Row[]> {
    const result = await this.guarded(() => this.pool.query<Row>(sql, params), priority);
    return result.rows;
  }

  /** Runs `fn` on one dedicated connection (for multi-statement work). */
  async withClient<T>(fn: (client: Client) => Promise<T>, priority: Priority = "write"): Promise<T> {
    return this.guarded(async () => {
      const client = await this.pool.connect();
      try {
        const result = await fn(client);
        client.release();
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // A broken connection is destroyed instead of going back to the pool.
        client.release(isNodeFailure(err) ? (err as Error) : undefined);
        throw err;
      }
    }, priority);
  }

  /** BEGIN ... COMMIT around `fn`; rolls back on any error. */
  async transaction<T>(fn: (client: Client) => Promise<T>, priority: Priority = "write"): Promise<T> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    }, priority);
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  private async guarded<T>(fn: () => Promise<T>, priority: Priority): Promise<T> {
    const maxQueue = priority === "write" ? config.node.writeQueueLimit : config.node.readQueueLimit;
    return this.bulkhead.run(async () => {
      this.breaker.ensureClosed();
      try {
        const result = await fn();
        this.breaker.recordSuccess();
        return result;
      } catch (err) {
        if (isNodeFailure(err)) this.breaker.recordFailure(isDefinitelyDown(err));
        else this.breaker.recordSuccess(); // ordinary SQL error: the node itself is healthy
        throw err;
      }
    }, maxQueue);
  }
}
