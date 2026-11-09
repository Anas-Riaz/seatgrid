import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { config } from "../config.js";
import { AppError, forbidden, isNodeFailure, tooManyRequests, unauthorized } from "../errors.js";
import { type BucketLimit, takeToken } from "../redis/rateLimiter.js";
import { readToken, type TokenPayload } from "../services/tokens.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: TokenPayload;
  }
}

/** Tag every response with the coordinator that served it (shows load balancing at work). */
export const servedBy: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Served-By", config.coordinatorId);
  next();
};

/** Reads the bearer token if present. Use `requireUser` on routes that need a login. */
export const readUser: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) req.user = readToken(header.slice(7)) ?? undefined;
  next();
};

export const requireUser: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : unauthorized());
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next(req.user.isAdmin ? undefined : forbidden("Admins only"));
};

/** Token-bucket rate limit (shared by all coordinators through Redis). */
function rateLimit(keyOf: (req: Request) => string | null, limit: BucketLimit): RequestHandler {
  return async (req, _res, next) => {
    const key = keyOf(req);
    if (!key) return next();
    const retryAfter = await takeToken(key, limit);
    next(retryAfter > 0 ? tooManyRequests(retryAfter) : undefined);
  };
}

export const limitPerIp = rateLimit((req) => `ip:${req.ip}`, config.rateLimit.perIp);
export const limitPerUser = rateLimit((req) => (req.user ? `user:${req.user.username}` : null), config.rateLimit.perUser);

export const notFoundHandler = (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", details: err.flatten().fieldErrors });
  }
  if (err instanceof AppError) {
    return res.status(err.status).set(err.headers).json({ error: err.message });
  }
  if (isNodeFailure(err)) {
    console.warn(`[http] database unavailable: ${err.message}`);
    return res.status(503).set("Retry-After", "1").json({ error: "A database node is unavailable, try again shortly" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
