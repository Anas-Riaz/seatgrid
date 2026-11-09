import type { RequestHandler } from "express";
import { config } from "../config.js";
import { unavailable } from "../errors.js";

let inFlight = 0;

/**
 * Load shedding at the coordinator: cap the requests one coordinator works on
 * at once. Writes (holds, bookings) are shed first, so under extreme load new
 * bookings get a fast 503 while search keeps working — graceful degradation
 * instead of every request slowing down until nothing works.
 */
export const admissionControl: RequestHandler = (req, res, next) => {
  const isWrite = req.method !== "GET";
  const limit = isWrite ? config.admission.maxInFlightForWrites : config.admission.maxInFlight;
  if (inFlight >= limit) return next(unavailable("Server is busy, please retry in a moment"));

  inFlight++;
  res.once("close", () => inFlight--);
  next();
};

export const requestsInFlight = () => inFlight;
