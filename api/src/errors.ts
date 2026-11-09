/** An error that maps directly to an HTTP response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new AppError(400, message);
export const unauthorized = (message = "Please log in") => new AppError(401, message);
export const paymentRequired = (message: string) => new AppError(402, message);
export const forbidden = (message = "Not allowed") => new AppError(403, message);
export const notFound = (message: string) => new AppError(404, message);
export const conflict = (message: string) => new AppError(409, message);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, "Too many requests, slow down", { "Retry-After": String(retryAfterSeconds) });
export const unavailable = (message: string) =>
  new AppError(503, message, { "Retry-After": "1" });

/** PostgreSQL SQLSTATE codes the application reacts to. */
export const SqlState = {
  uniqueViolation: "23505",
  checkViolation: "23514",
} as const;

export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

const DEFINITELY_DOWN = new Set([
  "ENOTFOUND", // the host (container) is gone
  "ECONNREFUSED", // nothing listens: PostgreSQL crashed or stopped
  "EHOSTUNREACH",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up / shutting down)
]);

/**
 * True when an error proves the node is down. A timeout does NOT: an overloaded
 * node and a dead node both time out, and treating "busy" as "dead" causes
 * needless (and lossy) failovers.
 */
export function isDefinitelyDown(err: unknown): boolean {
  const code = sqlState(err);
  return code !== undefined && DEFINITELY_DOWN.has(code);
}

/**
 * True when an error means "the database node is unreachable or unhealthy"
 * (as opposed to a normal SQL error such as a constraint violation).
 * Node failures feed circuit breakers and trigger replica-to-primary fallback.
 */
export function isNodeFailure(err: unknown): boolean {
  if (err instanceof AppError) return err.status === 503;
  const code = sqlState(err);
  const isSqlError = code !== undefined && /^[0-9A-Z]{5}$/.test(code);
  if (!isSqlError) return true; // ECONNREFUSED, connection terminated, timeouts...
  // 08 = connection exception, 53 = insufficient resources, 57 = operator intervention / statement timeout
  return code.startsWith("08") || code.startsWith("53") || code.startsWith("57");
}
