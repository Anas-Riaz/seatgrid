import { Router } from "express";
import { z } from "zod";
import * as users from "../../services/users.js";
import { limitPerUser, requireUser } from "../middleware.js";

export const authRoutes = Router();

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, "3-20 letters, digits or underscores");

const registerBody = z.object({
  username,
  email: z.string().trim().email(),
  password: z.string().min(8).max(100),
});

const loginBody = z.object({ username, password: z.string().min(1) });

authRoutes.get("/auth/username-available", async (req, res) => {
  const name = username.parse(req.query.username);
  res.json({ username: name, available: await users.isUsernameAvailable(name) });
});

authRoutes.post("/auth/register", async (req, res) => {
  const body = registerBody.parse(req.body);
  res.status(201).json(await users.register(body.username, body.email, body.password));
});

authRoutes.post("/auth/login", async (req, res) => {
  const body = loginBody.parse(req.body);
  res.json(await users.login(body.username, body.password));
});

authRoutes.get("/me", requireUser, limitPerUser, async (req, res) => {
  res.json(await users.getProfile(req.user!.username));
});
