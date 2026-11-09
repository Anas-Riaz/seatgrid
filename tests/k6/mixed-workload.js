// Mixed workload: 80% search, 15% seat map, 5% booking.
// Run it with 1 and with 3 coordinators (API_REPLICAS) and compare throughput and latency.
//
//   docker compose --profile tools run --rm k6 run /tests/mixed-workload.js
//   (options: -e VUS=200 -e DURATION=2m)
import { check } from "k6";
import http from "k6/http";
import { BASE, EXPECTED_STATUSES, holdAndBook, loginUsers } from "./lib.js";

const VUS = Number(__ENV.VUS || 200);
const EVENTS = Number(__ENV.EVENTS || 20); // spread over the first N matches
const QUERIES = ["karachi", "lahore", "islamabad united", "zalmi", "multan", "quetta", "gaddafi", "kings vs"];
const SORTS = ["date", "price", "availability", "title"];

export const options = {
  setupTimeout: "5m",
  scenarios: {
    mixed: { executor: "constant-vus", vus: VUS, duration: __ENV.DURATION || "2m" },
  },
  thresholds: {
    "http_req_duration{name:search}": ["p(95)<300"],
    "http_req_duration{name:seatmap}": ["p(95)<300"],
  },
};

http.setResponseCallback(EXPECTED_STATUSES);

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const randomInt = (max) => 1 + Math.floor(Math.random() * max);

export function setup() {
  return { tokens: loginUsers(VUS, 5001) };
}

export default function (data) {
  const roll = Math.random();
  if (roll < 0.8) {
    const res = http.get(`${BASE}/api/events?q=${encodeURIComponent(pick(QUERIES))}&sort=${pick(SORTS)}`, {
      tags: { name: "search" },
    });
    check(res, { "search ok": (r) => r.status === 200 });
  } else if (roll < 0.95) {
    const res = http.get(`${BASE}/api/events/${randomInt(EVENTS)}/sections/${randomInt(20)}/seats`, {
      tags: { name: "seatmap" },
    });
    check(res, { "seat map ok": (r) => r.status === 200 });
  } else {
    const token = data.tokens[(__VU - 1) % data.tokens.length];
    const { hold } = holdAndBook(token, randomInt(EVENTS), randomInt(20), { quantity: 1 });
    check(hold, { "hold answered": (r) => [201, 409, 429, 503].includes(r.status) });
  }
}
