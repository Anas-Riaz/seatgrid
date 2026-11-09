// Race test: many users try to buy the SAME seat at the same moment.
// Expected: exactly one booking, everybody else gets "seat taken" (409).
//
//   docker compose --profile tools run --rm k6 run /tests/race-one-seat.js
//   (options: -e USERS=500 -e EVENT=2 -e SECTION=7 -e SEAT=123)
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { EXPECTED_STATUSES, holdAndBook, loginUsers, verifyConsistency } from "./lib.js";

const USERS = Number(__ENV.USERS || 500);
const EVENT = Number(__ENV.EVENT || 2);
const SECTION = Number(__ENV.SECTION || 7);

const bookingsConfirmed = new Counter("bookings_confirmed");
const refusedTaken = new Counter("refused_seat_taken");
const refusedBusy = new Counter("refused_busy"); // 429/503: shed by rate limiting or admission control

export const options = {
  setupTimeout: "5m",
  scenarios: {
    race: { executor: "per-vu-iterations", vus: USERS, iterations: 1, maxDuration: "2m" },
  },
  thresholds: {
    bookings_confirmed: ["count==1"],
    "http_req_duration{name:hold}": ["p(95)<1500"],
  },
};

http.setResponseCallback(EXPECTED_STATUSES);

export function setup() {
  const seat = Number(__ENV.SEAT || 1 + Math.floor(Math.random() * 1000));
  console.log(`${USERS} users racing for event ${EVENT}, section ${SECTION}, seat ${seat}`);
  return { tokens: loginUsers(USERS, 1001), seat };
}

export default function (data) {
  const { hold, booking } = holdAndBook(data.tokens[__VU - 1], EVENT, SECTION, { seatNos: [data.seat] });
  if (hold.status === 409) refusedTaken.add(1);
  if (hold.status === 429 || hold.status === 503) refusedBusy.add(1);
  if (booking && booking.status === 201) bookingsConfirmed.add(1);
  check(hold, { "hold answered (201, or a clean refusal)": (r) => [201, 409, 429, 503].includes(r.status) });
}

export function teardown() {
  check(null, { "consistency verifier passes": () => verifyConsistency() });
}
