import { Router } from "express";
import { z } from "zod";
import * as reports from "../../services/reports.js";
import { requireAdmin } from "../middleware.js";

export const adminRoutes = Router();

adminRoutes.use("/admin", requireAdmin);

adminRoutes.get("/admin/sales", async (_req, res) => {
  res.json(await reports.salesReport());
});

adminRoutes.get("/admin/bookings", async (req, res) => {
  const query = z
    .object({
      username: z.string().trim().toLowerCase().default(""),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
    })
    .parse(req.query);
  res.json(await reports.searchBookings(query.username, query.limit, query.cursor));
});

adminRoutes.get("/admin/verify", async (_req, res) => {
  res.json(await reports.verifyConsistency());
});

adminRoutes.get("/admin/transactions", async (_req, res) => {
  res.json(await reports.transactionLog());
});
