import { Router } from "express";
import { cluster } from "../../cluster/cluster.js";
import { config } from "../../config.js";
import { requestsInFlight } from "../admissionControl.js";
import { leaderLease } from "../../redis/leaderLease.js";
import { redisReady } from "../../redis/redis.js";
import * as reports from "../../services/reports.js";

export const systemRoutes = Router();

/** Liveness for NGINX and Docker. Coordinators are stateless, so "up" only needs the process. */
systemRoutes.get("/health", (_req, res) => {
  res.json({
    coordinator: config.coordinatorId,
    leader: leaderLease.isLeader,
    shardMapVersion: cluster.version,
    redis: redisReady() ? "up" : "down",
    requestsInFlight: requestsInFlight(),
  });
});

/** Shard map, node health, replication lag and current leader. */
systemRoutes.get("/api/cluster", async (_req, res) => {
  res.json(await reports.clusterStatus());
});
