import pg from "pg";
import { config } from "../config.js";

/** Meta database: the versioned shard map and the 2PC transaction log. */
export const meta = new pg.Pool({
  connectionString: config.metaDatabaseUrl,
  max: 10,
  connectionTimeoutMillis: 2_000,
  statement_timeout: 3_000,
});

meta.on("error", (err) => console.warn(`[meta] idle client error: ${err.message}`));
