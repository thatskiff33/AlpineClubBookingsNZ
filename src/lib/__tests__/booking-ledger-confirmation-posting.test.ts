/**
 * What a confirmed booking's price looks like as lines (#3580).
 */
import { describe, expect, it } from "vitest";
import {
  planConfirmationChargeLines,
  type ConfirmationPostingBooking,
} from "@/lib/booking-ledger-confirmation-posting";

const D = (day: string) => new Date(`2026-08-${day}T00:00:00.000Z`);

function booking(overrides: Partial<ConfirmationPostingBooking> = {}): ConfirmationPostingBooking {
  return {
    id: "booking-1",
    lodgeId: "lodge-1",
    totalPriceCents: 13_000,
    promoAdjustmentCents: 0,
    guests: [
      {
        id: "guest-1",
        firstName: "A",
        lastName: "Member",
        ageTier: "ADULT",
        rateMembershipTypeId: "type-1",
        nights: [
          { stayDate: D("01"), priceCents: 6500 },
          { stayDate: D("02"), priceCents: 6500 },
        ],
      },
    ],
    ...overrides,
  };
}

describe("planConfirmationChargeLines", () => {
  it("posts one line per night and reconciles to the booking's final price", () => {
    const plan = planConfirmationChargeLines(booking());
    expect(plan.postings).toHaveLength(2);
    expect(plan.reconciles).toBe(true);
    expect(plan.unpricedStrandIds).toEqual([]);
    const first = plan.postings[0];
    expect(first?.kind).toBe("GUEST_NIGHT");
    expect(first?.unitCents).toBe(6500);
    expect(first?.quantity).toBe(1);
    expect(first?.bookingGuestId).toBe("guest-1");
    expect(first?.nightStart).toEqual(D("01"));
    // Half-open, like every stay range here: the morning after the night.
    expect(first?.nightEndExclusive).toEqual(D("02"));
    expect(first?.guestNames).toEqual(["A Member"]);
    expect(first?.ageTier).toBe("ADULT");
    expect(first?.rateMembershipTypeId).toBe("type-1");
  });

  it("posts the promotion as one negative line, and never the discount projection", () => {
    // `discountCents` is `max(0, -promoAdjustmentCents)` (INV-MONEY-031), so a
    // line for it would count the same discount twice.
    const plan = planConfirmationChargeLines(
      booking({ promoAdjustmentCents: -2000 }),
    );
    const promo = plan.postings.filter((posting) => posting.kind === "PROMOTION");
    expect(promo).toHaveLength(1);
    expect(promo[0]?.sign).toBe(-1);
    expect(promo[0]?.unitCents).toBe(2000);
    expect(plan.postings.some((posting) => posting.kind === "GROUP_DISCOUNT")).toBe(false);
    expect(plan.reconciles).toBe(true);
  });

  it("posts a price-RAISING promotion with a positive sign (#2267's incident shape)", () => {
    const plan = planConfirmationChargeLines(booking({ promoAdjustmentCents: 1500 }));
    const promo = plan.postings.find((posting) => posting.kind === "PROMOTION");
    expect(promo?.sign).toBe(1);
    expect(promo?.unitCents).toBe(1500);
    expect(plan.reconciles).toBe(true);
  });

  it("posts nothing for a strand holding an unpriced night, and says which", () => {
    // INV-MOD-028: a blank night is not evidence of an amount, and a guessed
    // figure would land in a row that is never edited again.
    const plan = planConfirmationChargeLines(
      booking({
        guests: [
          {
            id: "guest-1",
            firstName: "A",
            lastName: "Member",
            ageTier: "ADULT",
            rateMembershipTypeId: null,
            nights: [
              { stayDate: D("01"), priceCents: 6500 },
              { stayDate: D("02"), priceCents: null },
            ],
          },
        ],
      }),
    );
    expect(plan.postings).toEqual([]);
    expect(plan.unpricedStrandIds).toEqual(["guest-1"]);
    expect(plan.reconciles).toBe(false);
  });

  it("prices each strand independently, so one blank does not lose the others", () => {
    const plan = planConfirmationChargeLines(
      booking({
        totalPriceCents: 19_500,
        guests: [
          ...booking().guests,
          {
            id: "guest-2",
            firstName: "B",
            lastName: "Guest",
            ageTier: "CHILD",
            rateMembershipTypeId: null,
            nights: [{ stayDate: D("01"), priceCents: null }],
          },
        ],
      }),
    );
    expect(plan.postings).toHaveLength(2);
    expect(plan.postings.every((posting) => posting.bookingGuestId === "guest-1")).toBe(true);
    expect(plan.unpricedStrandIds).toEqual(["guest-2"]);
    expect(plan.reconciles).toBe(false);
  });

  it("does not reconcile when the night rows disagree with the stored total", () => {
    // The mismatch class INV-MONEY-031 already reports; the plan states it
    // rather than silently posting a price nobody agreed to.
    const plan = planConfirmationChargeLines(booking({ totalPriceCents: 12_999 }));
    expect(plan.postings).toHaveLength(2);
    expect(plan.reconciles).toBe(false);
  });

  it("posts nothing for a strand with no nights at all, and stays quiet about it", () => {
    const plan = planConfirmationChargeLines(
      booking({
        totalPriceCents: 0,
        guests: [
          {
            id: "guest-1",
            firstName: "A",
            lastName: "Member",
            ageTier: "ADULT",
            rateMembershipTypeId: null,
            nights: [],
          },
        ],
      }),
    );
    expect(plan.postings).toEqual([]);
    expect(plan.unpricedStrandIds).toEqual([]);
    expect(plan.reconciles).toBe(true);
  });

  it("counts a comped night as a real sold price of zero", () => {
    const plan = planConfirmationChargeLines(
      booking({
        totalPriceCents: 6500,
        guests: [
          {
            id: "guest-1",
            firstName: "A",
            lastName: "Member",
            ageTier: "ADULT",
            rateMembershipTypeId: null,
            nights: [
              { stayDate: D("01"), priceCents: 6500 },
              { stayDate: D("02"), priceCents: 0 },
            ],
          },
        ],
      }),
    );
    expect(plan.postings).toHaveLength(2);
    expect(plan.reconciles).toBe(true);
  });

  it("keys every line deterministically, so a second settle of the same booking posts nothing new (#3595)", () => {
    // The double-post path: mark-paid, reverse it (status back to payable),
    // then a card payment — the PAID claim succeeds twice. Same booking, same
    // keys, and the write door's ON CONFLICT DO NOTHING makes the second a no-op.
    const first = planConfirmationChargeLines(booking({ promoAdjustmentCents: -2000 }));
    const second = planConfirmationChargeLines(booking({ promoAdjustmentCents: -2000 }));
    const keys = first.postings.map((posting) => posting.postingKey);
    expect(second.postings.map((posting) => posting.postingKey)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "confirmation:booking-1:night:guest-1:2026-08-01",
      "confirmation:booking-1:night:guest-1:2026-08-02",
      "confirmation:booking-1:promotion",
    ]);
  });

  it("gives two guests on the same night different keys", () => {
    const plan = planConfirmationChargeLines(
      booking({
        totalPriceCents: 13_000,
        guests: [
          { id: "guest-1", firstName: "A", lastName: "One", ageTier: "ADULT", rateMembershipTypeId: null, nights: [{ stayDate: D("01"), priceCents: 6500 }] },
          { id: "guest-2", firstName: "B", lastName: "Two", ageTier: "ADULT", rateMembershipTypeId: null, nights: [{ stayDate: D("01"), priceCents: 6500 }] },
        ],
      }),
    );
    const keys = plan.postings.map((posting) => posting.postingKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("posts nights oldest first whatever order the rows arrive in", () => {
    const plan = planConfirmationChargeLines(
      booking({
        guests: [
          {
            id: "guest-1",
            firstName: "A",
            lastName: "Member",
            ageTier: "ADULT",
            rateMembershipTypeId: null,
            nights: [
              { stayDate: D("02"), priceCents: 6500 },
              { stayDate: D("01"), priceCents: 6500 },
            ],
          },
        ],
      }),
    );
    expect(plan.postings.map((posting) => posting.nightStart)).toEqual([D("01"), D("02")]);
  });
});
