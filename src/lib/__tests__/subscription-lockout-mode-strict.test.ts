/**
 * `peekSubscriptionLockoutModeStrict` — the EVIDENCE reader for the club's
 * subscription-lockout mode (#2376).
 *
 * WHY IT HAD TO EXIST. `peekSubscriptionLockoutMode` reads through two functions
 * that each turn a database failure into a safe-looking default:
 * `loadEffectiveModuleFlags` logs and returns "every optional module off", and
 * `loadPersistedMembershipLockoutSettings` returns null for ANY error, which then
 * normalizes to the documented defaults. Composed, one transient failure on a cold
 * cache yields `NO_BLOCK` — "this club does not block unfinancial members" — which
 * is a confident statement about the club's own policy that nobody observed.
 *
 * That is the right direction for a product path and the wrong one for evidence:
 * the mode is the qualifier on every subscription finding AI Diagnostics reports,
 * so a fabricated `NO_BLOCK` turns "this member is locked out" into "nothing is
 * blocking them". `INV-LOCKOUT-009`..`INV-LOCKOUT-011`.
 *
 * The pair of assertions that matters most in this file is the LAST describe: the
 * ordinary reader must still swallow, because #2376 may not change what a booking
 * screen does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const prismaMock = vi.hoisted(() => ({
  clubModuleSettings: { findUnique: vi.fn() },
  membershipLockoutSettings: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

/**
 * Stubbed so the ordinary reader's financial-year reseed cannot reach Xero from a
 * unit test. It is not the subject here — and the strict reader deliberately does
 * not call it at all, which the last test in the first describe asserts.
 */
const refreshFinancialYearConfig = vi.hoisted(() => vi.fn(async () => 3));
vi.mock("@/lib/financial-year-server", () => ({ refreshFinancialYearConfig }));

import {
  peekSubscriptionLockoutMode,
  peekSubscriptionLockoutModeStrict,
  resolveSubscriptionLockoutMode,
} from "@/lib/member-subscription-eligibility";

/** Module flags with Xero on, in the shape the settings row carries. */
const XERO_ON = { xeroIntegration: true };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.clubModuleSettings.findUnique.mockResolvedValue(XERO_ON);
  prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
    mode: "NON_MEMBER_PRICING",
  });
});

describe("peekSubscriptionLockoutModeStrict (#2376)", () => {
  it("returns the club's stored mode", async () => {
    await expect(peekSubscriptionLockoutModeStrict()).resolves.toBe(
      "NON_MEMBER_PRICING",
    );
  });

  it("PROPAGATES a failed module-flags read instead of answering NO_BLOCK", async () => {
    prismaMock.clubModuleSettings.findUnique.mockRejectedValue(
      new Error("module settings unavailable"),
    );
    await expect(peekSubscriptionLockoutModeStrict()).rejects.toThrow(
      "module settings unavailable",
    );
    // And it did not go on to read the lockout row: the failure is the answer.
    expect(prismaMock.membershipLockoutSettings.findUnique).not.toHaveBeenCalled();
  });

  it("PROPAGATES a failed lockout-settings read instead of answering the default", async () => {
    prismaMock.membershipLockoutSettings.findUnique.mockRejectedValue(
      new Error("lockout settings unavailable"),
    );
    await expect(peekSubscriptionLockoutModeStrict()).rejects.toThrow(
      "lockout settings unavailable",
    );
  });

  it("treats a genuinely ABSENT lockout row as the documented default, not as a failure", async () => {
    // The other half of the distinction. A club that has never saved the panel is
    // governed by the documented default, so reporting it is an observation.
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue(null);
    await expect(peekSubscriptionLockoutModeStrict()).resolves.toBe("HARD_BLOCK");
  });

  it("still answers NO_BLOCK when Xero is genuinely OFF", async () => {
    // Not a fallback: subscriptions are invoiced through Xero, so with the module
    // off no member could ever reach PAID and neither refusing nor repricing them
    // would be honest. The point of the strict reader is that this answer now means
    // only this.
    prismaMock.clubModuleSettings.findUnique.mockResolvedValue({
      xeroIntegration: false,
    });
    await expect(peekSubscriptionLockoutModeStrict()).resolves.toBe("NO_BLOCK");
    expect(prismaMock.membershipLockoutSettings.findUnique).not.toHaveBeenCalled();
  });

  it("does NOT reseed the financial-year cache", async () => {
    // A read-only evidence path must not change what other requests in this process
    // compute, and the reseed can reach Xero. `resolveSubscriptionLockoutMode` is
    // the variant that does reseed, and it is asserted here so the contrast is
    // pinned rather than assumed.
    await peekSubscriptionLockoutModeStrict();
    expect(refreshFinancialYearConfig).not.toHaveBeenCalled();
    await resolveSubscriptionLockoutMode();
    expect(refreshFinancialYearConfig).toHaveBeenCalledTimes(1);
  });
});

describe("the ordinary reader still swallows, because product paths must not change", () => {
  it("answers NO_BLOCK when the module-flags read fails", async () => {
    prismaMock.clubModuleSettings.findUnique.mockRejectedValue(
      new Error("module settings unavailable"),
    );
    await expect(peekSubscriptionLockoutMode()).resolves.toBe("NO_BLOCK");
  });

  it("answers the documented default when the lockout read fails", async () => {
    prismaMock.membershipLockoutSettings.findUnique.mockRejectedValue(
      new Error("lockout settings unavailable"),
    );
    await expect(peekSubscriptionLockoutMode()).resolves.toBe("HARD_BLOCK");
  });
});
