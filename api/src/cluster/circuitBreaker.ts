import { unavailable } from "../errors.js";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Stops calling a node that keeps failing, so a dead or slow shard fails fast
 * instead of tying up requests until they time out.
 *
 *   CLOSED    normal; count consecutive failures
 *   OPEN      reject immediately for `openMs`
 *   HALF_OPEN let one trial call through; success closes, failure re-opens
 */
export class CircuitBreaker {
  private state: State = "CLOSED";
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number,
    private readonly openMs: number,
  ) {}

  get currentState(): State {
    return this.state;
  }

  /** Throws 503 if the circuit is open. Call before every request to the node. */
  ensureClosed(): void {
    if (this.state === "OPEN" && Date.now() - this.openedAt >= this.openMs) {
      this.state = "HALF_OPEN";
    }
    if (this.state === "OPEN" || (this.state === "HALF_OPEN" && this.trialInFlight)) {
      throw unavailable(`${this.name} is unavailable (circuit open)`);
    }
    if (this.state === "HALF_OPEN") this.trialInFlight = true;
  }

  recordSuccess(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.trialInFlight = false;
  }

  /** @param definite the error proves the node is down (e.g. host gone): open at once. */
  recordFailure(definite = false): void {
    this.trialInFlight = false;
    this.failures++;
    if (definite || this.state === "HALF_OPEN" || this.failures >= this.failureThreshold) {
      if (this.state !== "OPEN") console.warn(`[breaker] ${this.name} OPEN`);
      this.state = "OPEN";
      this.openedAt = Date.now();
    }
  }
}
