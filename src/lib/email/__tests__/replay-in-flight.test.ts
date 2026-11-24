/**
 * #5433 (round 4, item 6): the longest the email retry job's replay may still
 * be sending, from the configured transport timeouts, never under the job's
 * own backoff.
 */
import { describe, expect, it } from "vitest";

import { replayInFlightWindowMs, SMTP_REPLIES_PER_MESSAGE } from "@/lib/email/replay-in-flight";
import { EMAIL_RETRY_BACKOFF_MS } from "@/lib/email/retry-selection";

describe("replayInFlightWindowMs", () => {
  it("is the backoff with the default timeouts (30 s setup and 6 x 120 s is under 15 minutes)", () => {
    expect(replayInFlightWindowMs({})).toBe(EMAIL_RETRY_BACKOFF_MS);
  });

  it("is the setup budget plus one inactivity timeout per server reply when that is longer", () => {
    expect(SMTP_REPLIES_PER_MESSAGE).toBe(6);
    expect(replayInFlightWindowMs({ EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "600000", EMAIL_SMTP_SOCKET_TIMEOUT_MS: "600000" })).toBe(70 * 60_000);
    expect(replayInFlightWindowMs({ EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "60000", EMAIL_SMTP_SOCKET_TIMEOUT_MS: "300000" })).toBe(31 * 60_000);
  });

  it("falls back to the defaults for a value out of range, so the window is never shortened by a typo", () => {
    expect(replayInFlightWindowMs({ EMAIL_SMTP_SOCKET_TIMEOUT_MS: "5" })).toBe(EMAIL_RETRY_BACKOFF_MS);
  });
});
