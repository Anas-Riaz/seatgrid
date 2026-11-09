// One user hammers the API from 30 connections. The per-user token bucket
// (10 req/s, burst 20, shared by all coordinators through Redis) must answer
// the excess with 429 + Retry-After instead of letting it through.
//
//   docker compose --profile tools run --rm k6 run /tests/rate-limit.js
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { authParams, BASE, EXPECTED_STATUSES, login } from "./lib.js";

const allowed = new Counter("allowed");
const limited = new Counter("rate_limited");

export const options = {
  scenarios: { hammer: { executor: "constant-vus", vus: 30, duration: "10s" } },
  thresholds: { rate_limited: ["count>0"] },
};

http.setResponseCallback(EXPECTED_STATUSES);

export function setup() {
  return { token: login("demo") };
}

export default function (data) {
  const res = http.get(`${BASE}/api/me`, authParams(data.token));
  if (res.status === 200) allowed.add(1);
  if (res.status === 429) limited.add(1);
  check(res, { "429 carries Retry-After": (r) => r.status !== 429 || r.headers["Retry-After"] !== undefined });
}
