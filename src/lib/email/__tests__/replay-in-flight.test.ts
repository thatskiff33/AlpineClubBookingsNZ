/**
 * #5433 (round 4, item 6): the longest the email retry job's replay may still
 * be sending, from the configured transport timeouts, never under the job's
 * own backoff.
 */
import { describe, expect, it } from "vitest";

import { replayInFlightWindowMs, SMTP_REPLIES_PER_MESSAGE } from "@/lib/email/replay-in-flight";
import { EMAIL_RETRY_BACKOFF_MS } from "@/lib/email/retry-selection";

describe("replayInFlightWindowMs", () => {
  it("counts ten server replies after the setup deadline (STARTTLS and AUTH LOGIN, round 5 F1)", () => {
    expect(SMTP_REPLIES_PER_MESSAGE).toBe(10);
  });

  it("is 20.5 minutes with the default timeouts: 30 s of setup and ten waits of 2 minutes", () => {
    expect(replayInFlightWindowMs({})).toBe(30_000 + 10 * 120_000);
  });

  it("is the setup budget plus one inactivity timeout per server reply", () => {
    expect(replayInFlightWindowMs({ EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "600000", EMAIL_SMTP_SOCKET_TIMEOUT_MS: "600000" })).toBe(110 * 60_000);
    expect(replayInFlightWindowMs({ EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "60000", EMAIL_SMTP_SOCKET_TIMEOUT_MS: "300000" })).toBe(51 * 60_000);
  });

  it("never goes under the retry backoff, however short the timeouts", () => {
    expect(replayInFlightWindowMs({ EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "1000", EMAIL_SMTP_SOCKET_TIMEOUT_MS: "1000" })).toBe(EMAIL_RETRY_BACKOFF_MS);
  });

  it("falls back to the defaults for a value out of range, so the window is never shortened by a typo", () => {
    expect(replayInFlightWindowMs({ EMAIL_SMTP_SOCKET_TIMEOUT_MS: "5" })).toBe(30_000 + 10 * 120_000);
  });
});
