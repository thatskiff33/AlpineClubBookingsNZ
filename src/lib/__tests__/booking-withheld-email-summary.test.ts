import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #2259 — the read behind the withheld-list banner.
 *
 * The banner is the compensating half of owner decision D10: an officer who
 * silenced a booking has to be told WHICH messages the member never received.
 * Three properties make that usable rather than merely present:
 *
 *   1. counts are EXACT and come from aggregates, so a chore-roster fan-out
 *      (one row per guest per date) cannot silently truncate the list — the
 *      original `take: 100` could, with no disclosure;
 *   2. rows are grouped per KIND, so those same dozens of roster rows cannot
 *      bury the single cancellation the member most needs to hear about;
 *   3. every read is genuinely BOUNDED, which the first grouped version only
 *      claimed — see the query test below.
 */

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      count: mocks.count,
      groupBy: mocks.groupBy,
      findMany: mocks.findMany,
    },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getWithheldBookingEmailSummary } from "@/lib/booking-email-suppression";

const AT_1 = new Date("2026-07-20T02:00:00.000Z");
const AT_2 = new Date("2026-07-19T21:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWithheldBookingEmailSummary (#2259)", () => {
  it("reports exact counts per kind and never truncates a fan-out", async () => {
    // groupBy returns them in no particular order — the sort is ours.
    mocks.count.mockResolvedValue(57);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "chore-roster",
        _count: { _all: 56 },
        _max: { createdAt: AT_2 },
      },
      {
        templateName: "booking-cancelled",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      {
        templateName: "booking-cancelled",
        subject: "Your booking has been cancelled",
      },
      { templateName: "chore-roster", subject: "Your chore for Saturday" },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");

    expect(summary.total).toBe(57);
    expect(summary.groups).toHaveLength(2);
    // The cancellation is a first-class entry, not row 57 of a truncated list,
    // and it sorts newest-first regardless of the aggregate's order.
    expect(summary.groups[0]).toMatchObject({
      templateName: "booking-cancelled",
      label: "Booking Cancelled",
      count: 1,
      remedy: "relay",
    });
    expect(summary.groups[1]).toMatchObject({
      templateName: "chore-roster",
      count: 56,
      // A live chore link exists but was never delivered, and nothing re-sends
      // it — the officer has to re-send the roster by hand.
      remedy: "resend-roster",
    });
  });

  it("bounds every read instead of fetching the booking's whole log", async () => {
    /*
      The first grouped version used findMany with `distinct` and an
      `orderBy: createdAt`. Prisma only pushes `distinct` into the query when it
      LEADS the orderBy, so that fetched every withheld row for the booking and
      deduped in memory — precisely the unbounded read the removed `take: 100`
      had been masking, while a comment claimed the registry bounded it.

      Groups now come from a database-side groupBy (one row per template), and
      the subject read is restricted to the per-template maxima under a cap.
    */
    mocks.count.mockResolvedValue(2);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "booking-cancelled",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
      {
        templateName: "chore-roster",
        _count: { _all: 1 },
        _max: { createdAt: AT_2 },
      },
    ]);
    mocks.findMany.mockResolvedValue([]);

    await getWithheldBookingEmailSummary("bk-1");

    const args = mocks.findMany.mock.calls[0][0];
    expect(args.take).toBeGreaterThan(0);
    expect(args.distinct).toBeUndefined();
    // Only rows sitting on a per-template maximum are even candidates.
    expect(args.where.createdAt).toEqual({ in: [AT_1, AT_2] });
  });

  it("keeps a group even when its subject was not read", async () => {
    // The aggregate produces the list, so a capped subject read can cost a
    // subject but must never drop a whole kind from the officer's list.
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "booking-cancelled",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].subject).toBe("");
  });

  it("marks the never-minted payment link as regenerating on its own", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "split-guest-payment-link",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      { templateName: "split-guest-payment-link", subject: "Your payment link" },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    // Verified: the mint is skipped pre-emptively and the settlement cron
    // re-mints, so clearing the switch really is the whole remedy here.
    expect(summary.groups[0].remedy).toBe("auto-regenerates");
  });

  it("gives the chore roster the harder remedy, not the payment link's", async () => {
    /*
      These two were conflated, and the difference is load-bearing.
      `admin-roster-service.ts` DELETES the guest's existing chore token, mints
      a fresh one, then sends — so a live link exists, the guest's old link is
      destroyed, and `sendChoreRosterEmail` has exactly one caller (the admin
      roster action) with no cron behind it. "Clear the switch and it
      regenerates" would be false twice over.
    */
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "chore-roster",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      { templateName: "chore-roster", subject: "Your chore for Saturday" },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    expect(summary.groups[0].remedy).toBe("resend-roster");
  });

  it("treats a relayable message as relayable", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "booking-cancelled",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      { templateName: "booking-cancelled", subject: "Your booking was cancelled" },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    // Nothing was minted and nothing expires: the officer can simply say it.
    expect(summary.groups[0].remedy).toBe("relay");
  });

  it("sends an officer to XERO for a withheld invoice email, never to relay it (#2929)", async () => {
    /*
      This case used to be the "relayable" example above, and it was wrong in a
      way that only became visible once a withhold could happen on a booking
      whose "No emails" switch was never on. There is nothing to relay: no body
      is retained, the officer cannot reproduce an invoice, clearing the switch
      re-sends nothing, and a re-drive short-circuits on the stored invoice id.
      The invoice exists and is owed; Xero is the only place it goes out from.
    */
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "xero-booking-invoice-email",
        _count: { _all: 1 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      { templateName: "xero-booking-invoice-email", subject: "Invoice INV-0042" },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    expect(summary.groups[0].remedy).toBe("resend-from-xero");
    expect(summary.groups[0].label).toBe("Xero invoice email");
  });

  it("reads only deliberately-withheld rows for the booking", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.groupBy.mockResolvedValue([]);
    mocks.findMany.mockResolvedValue([]);

    await getWithheldBookingEmailSummary("bk-42");

    for (const call of [
      mocks.count.mock.calls[0][0],
      mocks.groupBy.mock.calls[0][0],
    ]) {
      expect(call.where).toMatchObject({
        bookingId: "bk-42",
        status: "SKIPPED_NO_EMAILS",
      });
    }
    // With no groups there is nothing to look subjects up for.
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("never renders a count of zero for a kind it can see", async () => {
    // Defensive: an aggregate that somehow came back empty must not produce
    // "×0" beside a row that demonstrably exists.
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      {
        templateName: "booking-confirmed",
        _count: { _all: 0 },
        _max: { createdAt: AT_1 },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      { templateName: "booking-confirmed", subject: "Your booking is confirmed" },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    expect(summary.groups[0].count).toBe(1);
  });
});
