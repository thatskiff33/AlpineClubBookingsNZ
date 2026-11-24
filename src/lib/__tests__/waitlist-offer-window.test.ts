/**
 * #5433, owner decision D2: the window an offer gets when its email is really
 * sent by a later run. A full window from the send, capped at the check-in
 * date (its first instant at the club, through the club-time kernel), and
 * never earlier than the deadline the offer already carries.
 */
import { describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import {
  restartedWaitlistOfferExpiry,
  WAITLIST_OFFER_HOURS,
  waitlistOfferExpiresAt,
  waitlistOfferRestartCap,
} from "@/lib/waitlist-offer-window";

const zone = requireClubTimeZone("Pacific/Auckland");
const HOUR = 60 * 60 * 1000;
const sentAt = new Date("2026-07-01T00:00:00.000Z");

describe("the waitlist offer window", () => {
  it("is WAITLIST_OFFER_HOURS from when the offer is made", () => {
    expect(waitlistOfferExpiresAt(sentAt).getTime() - sentAt.getTime()).toBe(WAITLIST_OFFER_HOURS * HOUR);
  });

  it("caps a restart at the first instant of the check-in date at the club, not UTC midnight", () => {
    // 3 July in New Zealand (NZST, UTC+12) begins at 12:00 UTC on 2 July.
    expect(waitlistOfferRestartCap(new Date("2026-07-03T00:00:00.000Z"), zone).toISOString()).toBe("2026-07-02T12:00:00.000Z");
  });
});

describe("restartedWaitlistOfferExpiry (D2)", () => {
  it("gives a full window from the send when the check-in date is further off", () => {
    const expiresAt = restartedWaitlistOfferExpiry({
      sentAt,
      currentExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      zone,
    });
    expect(expiresAt.toISOString()).toBe(waitlistOfferExpiresAt(sentAt).toISOString());
  });

  it("stops at the check-in date when a full window would run past it", () => {
    const expiresAt = restartedWaitlistOfferExpiry({
      sentAt,
      currentExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      checkIn: new Date("2026-07-02T00:00:00.000Z"),
      zone,
    });
    expect(expiresAt.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("never moves a deadline earlier: an offer made close to its check-in keeps the deadline it carries", () => {
    const current = new Date("2026-07-02T18:00:00.000Z");
    const expiresAt = restartedWaitlistOfferExpiry({ sentAt, currentExpiresAt: current, checkIn: new Date("2026-07-02T00:00:00.000Z"), zone });
    expect(expiresAt.toISOString()).toBe(current.toISOString());
  });

  it("caps an offer with no deadline at all", () => {
    const expiresAt = restartedWaitlistOfferExpiry({ sentAt, currentExpiresAt: null, checkIn: new Date("2026-07-02T00:00:00.000Z"), zone });
    expect(expiresAt.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });
});
