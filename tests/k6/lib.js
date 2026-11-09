// Shared helpers for the k6 tests.
import http from "k6/http";
import { fail, sleep } from "k6";

export const BASE = __ENV.BASE_URL || "http://localhost:8080";
export const PASSWORD = "password123"; // every seeded user has this password

const JSON_HEADERS = { "Content-Type": "application/json" };
// Logins are tagged so their (deliberately slow, scrypt) latency stays out of the test results.
const LOGIN_PARAMS = { headers: JSON_HEADERS, tags: { name: "login" } };

/** user0000001, user0000002, ... (created by the seed job) */
export const seededUser = (n) => `user${String(n).padStart(7, "0")}`;

export function authParams(token, tags = {}) {
  return { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }, tags };
}

export function login(username) {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username, password: PASSWORD }), LOGIN_PARAMS);
  if (res.status !== 200) fail(`login ${username} failed: ${res.status} ${res.body}`);
  return res.json("token");
}

/**
 * Log in `count` seeded users (starting at `first`) in parallel batches; returns their tokens.
 * Busy answers (502/503) are retried, since the cluster may still be warming up.
 */
export function loginUsers(count, first = 1) {
  const tokens = [];
  for (let start = 0; start < count; start += 50) {
    let pending = [];
    for (let i = start; i < Math.min(count, start + 50); i++) pending.push(seededUser(first + i));

    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > 5) fail(`login failed for ${pending.length} users`);
      const requests = pending.map((username) => [
        "POST",
        `${BASE}/api/auth/login`,
        JSON.stringify({ username, password: PASSWORD }),
        LOGIN_PARAMS,
      ]);
      const responses = http.batch(requests);
      const retry = [];
      responses.forEach((res, i) => {
        if (res.status === 200) tokens.push(res.json("token"));
        else if (res.status === 502 || res.status === 503) retry.push(pending[i]);
        else fail(`login failed: ${res.status} ${res.body}`);
      });
      pending = retry;
      if (pending.length > 0) sleep(1);
    }
  }
  return tokens;
}

/** Hold seats, then pay for them. Returns the booking response, or null if the hold was refused. */
export function holdAndBook(token, eventId, sectionId, choice) {
  const hold = http.post(
    `${BASE}/api/holds`,
    JSON.stringify({ eventId, sectionId, ...choice }),
    authParams(token, { name: "hold" }),
  );
  if (hold.status !== 201) return { hold, booking: null };

  const booking = http.post(
    `${BASE}/api/bookings`,
    JSON.stringify({ eventId, sectionId, holdId: hold.json("holdId"), idempotencyKey: `k6-${__VU}-${__ITER}-${Date.now()}` }),
    authParams(token, { name: "book" }),
  );
  return { hold, booking };
}

/** Runs the consistency verifier and prints every check. Returns true if all passed. */
export function verifyConsistency() {
  const res = http.get(`${BASE}/api/admin/verify`, authParams(login("admin")));
  if (res.status !== 200) fail(`verifier failed: ${res.status} ${res.body}`);
  const report = res.json();
  console.log("---------------- consistency verifier ----------------");
  for (const check of report.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}  (${check.detail})`);
  return report.ok;
}

/** Responses that are expected under load and must not count as failures. */
export const EXPECTED_STATUSES = http.expectedStatuses({ min: 200, max: 299 }, 402, 409, 429, 503);
