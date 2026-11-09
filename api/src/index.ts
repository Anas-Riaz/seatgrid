import express from "express";
import { cluster } from "./cluster/cluster.js";
import { config } from "./config.js";
import { adminRoutes } from "./http/routes/adminRoutes.js";
import { authRoutes } from "./http/routes/authRoutes.js";
import { bookingRoutes } from "./http/routes/bookingRoutes.js";
import { eventRoutes } from "./http/routes/eventRoutes.js";
import { systemRoutes } from "./http/routes/systemRoutes.js";
import { admissionControl } from "./http/admissionControl.js";
import { errorHandler, limitPerIp, notFoundHandler, readUser, servedBy } from "./http/middleware.js";
import { startBackgroundJobs } from "./jobs/scheduler.js";
import { redis } from "./redis/redis.js";
import { loadReferenceData } from "./services/catalog.js";

/**
 * A SeatGrid coordinator. Stateless: any coordinator can serve any request.
 * It routes to shards with the hash rings, merges results, runs 2PC, and —
 * if it holds the leader lease — runs failover and the background jobs.
 */
async function main() {
  await cluster.start();
  await loadReferenceData();
  startBackgroundJobs();

  const app = express();
  app.set("trust proxy", 1); // client IP comes from NGINX (one proxy hop)
  app.use(express.json({ limit: "20kb" }));
  app.use(servedBy);

  app.use(systemRoutes);
  app.use("/api", admissionControl, limitPerIp, readUser, authRoutes, eventRoutes, bookingRoutes, adminRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(config.port, () => {
    console.log(`Coordinator ${config.coordinatorId} listening on :${config.port}`);
  });

  // Graceful shutdown: finish in-flight requests when Docker stops or scales this coordinator.
  const shutdown = () => {
    server.close(() => {
      redis.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
