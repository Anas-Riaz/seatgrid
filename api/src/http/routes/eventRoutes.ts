import { Router } from "express";
import { z } from "zod";
import * as events from "../../services/events.js";

export const eventRoutes = Router();

const id = z.coerce.number().int().positive();

const searchQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(50).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["date", "price", "title", "availability"]).default("date"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

eventRoutes.get("/events", async (req, res) => {
  res.json(await events.searchEvents(searchQuery.parse(req.query)));
});

eventRoutes.get("/events/:eventId", async (req, res) => {
  res.json(await events.getEventDetail(id.parse(req.params.eventId)));
});

eventRoutes.get("/events/:eventId/sections/:sectionId/seats", async (req, res) => {
  res.json(await events.getSeatMap(id.parse(req.params.eventId), id.parse(req.params.sectionId)));
});
