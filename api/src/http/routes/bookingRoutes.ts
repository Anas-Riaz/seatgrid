import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import * as bookings from "../../services/bookings.js";
import * as holds from "../../services/holds.js";
import * as tickets from "../../services/tickets.js";
import { limitPerUser, requireUser } from "../middleware.js";

export const bookingRoutes = Router();

const id = z.coerce.number().int().positive();

const holdBody = z
  .object({
    eventId: id,
    sectionId: id,
    seatNos: z.array(z.number().int().positive()).min(1).max(config.holds.maxSeats).optional(),
    quantity: z.number().int().min(1).max(config.holds.maxSeats).optional(),
  })
  .refine((b) => (b.seatNos === undefined) !== (b.quantity === undefined), "Send either seatNos or quantity");

const bookingBody = z.object({
  eventId: id,
  sectionId: id,
  holdId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(64),
});

const crashHeader = z.enum(["prepare", "decision"]).optional();

/** Step 1: hold seats for a few minutes. */
bookingRoutes.post("/holds", requireUser, limitPerUser, async (req, res) => {
  res.status(201).json(await holds.createHold(req.user!.username, holdBody.parse(req.body)));
});

/** Give held seats back before they expire. */
bookingRoutes.delete("/holds/:holdId", requireUser, limitPerUser, async (req, res) => {
  const { eventId, sectionId } = z.object({ eventId: id, sectionId: id }).parse(req.query);
  const holdId = z.string().uuid().parse(req.params.holdId);
  res.json(await holds.releaseHold(req.user!.username, eventId, sectionId, holdId));
});

/** Step 2: pay for the held seats (Two-Phase Commit across the seat shard and the user shard). */
bookingRoutes.post("/bookings", requireUser, limitPerUser, async (req, res) => {
  const body = bookingBody.parse({ ...req.body, idempotencyKey: req.body?.idempotencyKey ?? req.get("Idempotency-Key") });
  const crashAfter = crashHeader.parse(req.get("X-Crash-After"));
  const result = await bookings.confirmBooking(req.user!.username, body, crashAfter);
  res.status(result.replayed ? 200 : 201).json(result);
});

bookingRoutes.get("/me/tickets", requireUser, limitPerUser, async (req, res) => {
  res.json(await tickets.myTickets(req.user!.username));
});

bookingRoutes.get("/tickets/:ticketNo", async (req, res) => {
  res.json(await tickets.lookupTicket(req.params.ticketNo));
});
