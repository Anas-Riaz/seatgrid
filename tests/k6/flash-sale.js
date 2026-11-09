// Flash sale: thousands of fans arrive within a minute for 5,000 seats
// (sections 1-5 of one match). The system must stay up, reject the excess
// gracefully (409 sold out / 429 / 503) and never sell a seat twice.
//
//   docker compose --profile tools run --rm k6 run /tests/flash-sale.js
//   (options: -e VUS=2000 -e EVENT=1)
import { check, sleep } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { BASE, EXPECTED_STATUSES, holdAndBook, loginUsers, verifyConsistency } from "./lib.js";

const VUS = Number(__ENV.VUS || 2000);
const EVENT = Number(__ENV.EVENT || 1);
const SECTIONS = [1, 2, 3, 4, 5]; // 5 x 1,000 seats

const ticketsSold = new Counter("tickets_sold");
const soldOut = new Counter("refused_sold_out");
const shed = new Counter("refused_overload");
// Latency of successful bookings only (deliberate 429/503 rejections are excluded).
const bookingLatency = new Trend("booking_latency", true);

export const options = {
  setupTimeout: "10m",
  scenarios: {
    flash_sale: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "60s", target: VUS },
        { duration: "30s", target: VUS },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    "http_req_duration{name:search}": ["p(95)<300"],
    booking_latency: ["p(95)<1500"],
    checks: ["rate>0.99"],
  },
};

http.setResponseCallback(EXPECTED_STATUSES);

export function setup() {
  return { tokens: loginUsers(Math.min(VUS, 2000)) };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];

  const search = http.get(`${BASE}/api/events?q=karachi&sort=availability&order=desc`, { tags: { name: "search" } });
  check(search, { "search never fails": (r) => r.status === 200 || r.status === 429 });

  const section = SECTIONS[Math.floor(Math.random() * SECTIONS.length)];
  const quantity = 1 + Math.floor(Math.random() * 2);
  const { hold, booking } = holdAndBook(token, EVENT, section, { quantity });

  if (hold.status === 409) soldOut.add(1);
  if (hold.status === 429 || hold.status === 503) shed.add(1);
  if (booking) {
    check(booking, { "booking answered": (r) => [200, 201, 402, 409, 429, 503].includes(r.status) });
    if (booking.status === 201) {
      ticketsSold.add(booking.json("tickets").length);
      bookingLatency.add(hold.timings.duration + booking.timings.duration);
    }
  }
  sleep(1 + Math.random());
}

export function teardown() {
  check(null, { "consistency verifier passes": () => verifyConsistency() });
}
