import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2258: a waitlist offer withheld by the per-booking "No emails" switch must
 * get its OWN visibility state. Folding it into "missing" / "undeliverable"
 * would tell an operator the member was not reached because something broke,
 * when in fact an admin chose silence — and would light up the stuck-state
 * dashboard and the booking-provider-mismatch board with a false alarm.
 */

const mocks = vi.hoisted(() => ({
  emailLogFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { emailLog: { findMany: mocks.emailLogFindMany } },
}));

import { BookingStatus } from "@prisma/client";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";

const OFFERED_AT = new Date("2026-06-20T10:00:00.000Z");

/**
 * An offer window that closed BEFORE the frozen "today" (2026-07-01, see
 * docs/TESTING.md). These fixtures used to sit in late July 2026 and read as
 * lapsed only because the real calendar had moved past them — the exact
 * dependency #2481 removed. Anchored behind the frozen instant they stay lapsed
 * for good, including under the rollover canary.
 */
const LAPSED_OFFER_EXPIRY = new Date("2026-06-21T10:00:00.000Z");

function booking(
  overrides: {
    id?: string;
    noEmails?: boolean;
    // Default: the offer has already lapsed, so a withhold is benign.
    offerExpiresAt?: Date | null;
  } = {},
) {
  return {
    id: overrides.id ?? "bk_1",
    status: BookingStatus.WAITLIST_OFFERED,
    waitlistOfferedAt: OFFERED_AT,
    waitlistOfferExpiresAt:
      overrides.offerExpiresAt === undefined
        ? LAPSED_OFFER_EXPIRY
        : overrides.offerExpiresAt,
    noEmails: overrides.noEmails ?? false,
    member: { email: "member@example.com" },
    // #3369: a member-owned fixture; the owner projection reads both halves.
    organisation: null,
  };
}

/** An offer that has NOT expired: far enough ahead to stay live in CI. */
function liveOfferExpiry() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

function emailLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "log_1",
    to: "member@example.com",
    bookingId: "bk_1",
    status: "SENT",
    attempts: 1,
    lastAttemptAt: OFFERED_AT,
    errorMessage: null,
    createdAt: OFFERED_AT,
    htmlBody: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailLogFindMany.mockResolvedValue([]);
});

describe("waitlist offer email visibility and the No emails switch (#2258)", () => {
  it("reports a withheld offer email as 'suppressed', not as a delivery failure", async () => {
    mocks.emailLogFindMany.mockResolvedValue([
      emailLog({
        status: "SKIPPED_NO_EMAILS",
        errorMessage: 'Withheld: this booking has the "No emails" switch turned on',
      }),
    ]);

    const deliveries = await getWaitlistOfferEmailDeliveries([
      booking({ noEmails: true }),
    ]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("suppressed");
    expect(delivery.needsOperatorAction).toBe(false);
    expect(delivery.status).toBe("SKIPPED_NO_EMAILS");
  });

  it("reports a suppressed booking with NO log row as 'suppressed', not 'missing'", async () => {
    // The normal shape: candidacy exclusion means no offer email was ever
    // attempted, so there is no EmailLog row at all.
    mocks.emailLogFindMany.mockResolvedValue([]);

    const deliveries = await getWaitlistOfferEmailDeliveries([
      booking({ noEmails: true }),
    ]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("suppressed");
    expect(delivery.needsOperatorAction).toBe(false);
  });

  it("still reports a genuinely missing offer email on an unsuppressed booking", async () => {
    mocks.emailLogFindMany.mockResolvedValue([]);

    const deliveries = await getWaitlistOfferEmailDeliveries([booking()]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("missing");
    expect(delivery.needsOperatorAction).toBe(true);
  });

  it("keeps a bounce distinguishable from a deliberate withhold", async () => {
    mocks.emailLogFindMany.mockResolvedValue([
      emailLog({ status: "BOUNCED", errorMessage: "hard bounce" }),
    ]);

    const deliveries = await getWaitlistOfferEmailDeliveries([booking()]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("undeliverable");
    expect(delivery.needsOperatorAction).toBe(true);
  });

  it("matches the log row to the booking by bookingId", async () => {
    mocks.emailLogFindMany.mockResolvedValue([
      emailLog({ id: "log_other", bookingId: "bk_other", status: "SENT" }),
      emailLog({ id: "log_mine", bookingId: "bk_1", status: "BOUNCED" }),
    ]);

    const deliveries = await getWaitlistOfferEmailDeliveries([booking()]);

    expect(deliveries.get("bk_1")!.emailLogId).toBe("log_mine");
  });
});

describe("a silenced booking sitting on a LIVE offer needs operator action (#2258)", () => {
  // Candidacy exclusion stops NEW offers, but it is not retroactive and it does
  // not cover the post-commit race, so this state is reachable — and it is the
  // bad one: a bed held for the whole offer window with the member never told,
  // which then simply lapses.
  it("reports suppressed_live_offer with needsOperatorAction when the offer is unexpired", async () => {
    mocks.emailLogFindMany.mockResolvedValue([]);

    const deliveries = await getWaitlistOfferEmailDeliveries([
      booking({ noEmails: true, offerExpiresAt: liveOfferExpiry() }),
    ]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("suppressed_live_offer");
    expect(delivery.needsOperatorAction).toBe(true);
  });

  it("does the same when a withheld offer-email row exists for a live offer", async () => {
    mocks.emailLogFindMany.mockResolvedValue([
      emailLog({ status: "SKIPPED_NO_EMAILS" }),
    ]);

    const deliveries = await getWaitlistOfferEmailDeliveries([
      booking({ noEmails: true, offerExpiresAt: liveOfferExpiry() }),
    ]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("suppressed_live_offer");
    expect(delivery.needsOperatorAction).toBe(true);
  });

  it("stays the benign suppressed state once the offer has lapsed", async () => {
    mocks.emailLogFindMany.mockResolvedValue([]);

    const deliveries = await getWaitlistOfferEmailDeliveries([
      booking({ noEmails: true, offerExpiresAt: LAPSED_OFFER_EXPIRY }),
    ]);

    const delivery = deliveries.get("bk_1")!;
    expect(delivery.retryState).toBe("suppressed");
    expect(delivery.needsOperatorAction).toBe(false);
  });

  it("stays benign when no expiry was ever recorded", async () => {
    mocks.emailLogFindMany.mockResolvedValue([]);

    const deliveries = await getWaitlistOfferEmailDeliveries([
      booking({ noEmails: true, offerExpiresAt: null }),
    ]);

    expect(deliveries.get("bk_1")!.retryState).toBe("suppressed");
    expect(deliveries.get("bk_1")!.needsOperatorAction).toBe(false);
  });
});
