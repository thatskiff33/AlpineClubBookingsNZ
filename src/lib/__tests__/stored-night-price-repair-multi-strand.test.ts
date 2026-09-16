import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualRefundTaskKind } from "@prisma/client";

/**
 * #3498: WHICH strands a settle may fill in, and WHICH ONE the settled amount
 * moves the stored worth of.
 *
 * Owner decision D1 put the whole parked edit on one work item, so a settle now
 * reads every strand that item names and can repair several of them. Two things
 * have to be right about that and neither is obvious:
 *
 *  1. every repairable strand is offered, in the item's own order, because the
 *     officer's figures come back as a parallel array matched by POSITION — that
 *     is what lets the browser go on never naming a guest strand;
 *  2. the settled amount moves AT MOST ONE strand's worth, and only ever the
 *     strand the item is about. "The first one with boxes" is a different rule
 *     that gives a different — and wrong — answer on the commonest parked shape
 *     there is.
 *
 * MUTATION PROOF. Derive `absorbsSettlement` as "the first repairable strand"
 * instead of "the lead strand, if it is repairable", and
 * "moves NO strand's worth when the strand the money is about has no blanks"
 * fails. Apply the delta to every strand and
 * "every other strand reconciles to its own stored total" fails. Drop the
 * length check and "refuses a stale screen rather than matching as far as it
 * goes" fails. All three were applied, all three failed this file, and all three
 * were restored (`docs/TESTING.md`).
 */

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("server-only", () => ({}));

import {
  loadUnpricedNightsSummaries,
  planStoredNightPriceRepair,
  reviewTaskGuestIds,
} from "@/lib/stored-night-price-repair-plan";
import { requireCalendarDate } from "@/lib/club-time";

const store = {
  bookingGuest: { findMany: (...a: unknown[]) => mocks.findMany(...a) },
} as never;

const NIGHTS = ["2026-08-10", "2026-08-11"] as const;

/** A strand holding two nights, blank or priced as asked. */
function guest(id: string, priceCents: number, blank: boolean) {
  return {
    id,
    priceCents,
    nights: NIGHTS.map((stayDate) => ({
      stayDate: new Date(`${stayDate}T00:00:00.000Z`),
      priceCents: blank ? null : priceCents / 2,
    })),
  };
}

/**
 * The item a parked REMOVAL raises, which is the shape that separates the two
 * candidate rules: the guest who LEFT leads (their nights are what moved) and
 * their own rows read perfectly, so they have no blanks at all; a guest nobody
 * touched is the first strand with any.
 */
function task(leadId: string, otherIds: readonly string[]) {
  return {
    kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
    reviewContext: {
      version: 1,
      occurrence: {
        bookingId: "booking-1",
        bookingGuestId: leadId,
        cause: "COUNTERPART_STRAND_UNREADABLE",
        surrenderedNightDates: [...NIGHTS],
        addedNightDates: [],
        storedEvidence: {
          guestTotalCents: 12_000,
          nightPrices: NIGHTS.map((date) => ({ date, priceCents: 6_000 })),
        },
        otherStrands: otherIds.map((bookingGuestId) => ({
          bookingGuestId,
          cause: "NO_STORED_NIGHT_PRICES",
          surrenderedNightDates: [],
          addedNightDates: [],
          storedEvidence: { guestTotalCents: 14_000, nightPrices: [] },
        })),
      },
      guestMemberId: null,
      bookingCheckIn: "2026-08-10",
      bookingCheckOut: "2026-08-12",
      bookingModificationId: "mod-1",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("which strands one item offers, and in what order (#3498)", () => {
  it("names every strand the item records, lead first", () => {
    expect(reviewTaskGuestIds(task("lead", ["other-a", "other-b"]))).toEqual([
      "lead",
      "other-a",
      "other-b",
    ]);
  });

  it("offers only the repairable ones, keeping the item's order", async () => {
    // `other-a` has blanks, `lead` and `other-b` do not - so the list is one
    // entry, and it is the one the officer can actually do something about.
    mocks.findMany.mockResolvedValue([
      guest("lead", 12_000, false),
      guest("other-a", 14_000, true),
      guest("other-b", 16_000, false),
    ]);
    const repairable = await loadUnpricedNightsSummaries({
      bookingGuestIds: ["lead", "other-a", "other-b"],
      store,
    });
    expect(repairable.map((strand) => strand.bookingGuestId)).toEqual([
      "other-a",
    ]);
  });
});

describe("which strand the settled amount moves (#3498)", () => {
  it("MUTATION: moves NO strand's worth when the strand the money is about has no blanks", async () => {
    /*
      THE CASE THE TWO CANDIDATE RULES DISAGREE ON, and the money is real. The
      club is handing $40.00 back for the guest who left. `other-a` is a guest
      nobody touched; making their nights come to their stored total PLUS that
      $40.00 would move a stranger's stay by somebody else's amount - silently,
      and against the very figure a later part-refund is worked out from.

      So the officer is asked for `other-a`'s stored total exactly: $140.00.
    */
    mocks.findMany.mockResolvedValue([
      guest("lead", 12_000, false),
      guest("other-a", 14_000, true),
    ]);
    const plans = await planStoredNightPriceRepair({
      task: task("lead", ["other-a"]),
      requested: [
        [
          { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
          { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
        ],
      ],
      settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
      store,
    });
    expect(plans.map((plan) => plan.bookingGuestId)).toEqual(["other-a"]);

    // And the OTHER figure - the one that would reconcile if the refund had been
    // applied here - is refused, which is what makes the case above non-vacuous.
    await expect(
      planStoredNightPriceRepair({
        task: task("lead", ["other-a"]),
        requested: [
          [
            { date: requireCalendarDate("2026-08-10"), priceCents: 5_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 5_000 },
          ],
        ],
        settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
        store,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("moves the LEAD strand's worth when that strand is the one with blanks", async () => {
    // The ordinary shape: the strand the money is about is also the one that
    // cannot be read, so the settlement moves exactly it - $120.00 stored, less
    // the $40.00 going back, is $80.00 across its two nights.
    mocks.findMany.mockResolvedValue([guest("lead", 12_000, true)]);
    const plans = await planStoredNightPriceRepair({
      task: task("lead", []),
      requested: [
        [
          { date: requireCalendarDate("2026-08-10"), priceCents: 4_000 },
          { date: requireCalendarDate("2026-08-11"), priceCents: 4_000 },
        ],
      ],
      settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
      store,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.entries.map((entry) => entry.priceCents)).toEqual([
      4_000, 4_000,
    ]);
  });

  it("every other strand reconciles to its own stored total, settlement or not", async () => {
    mocks.findMany.mockResolvedValue([
      guest("lead", 12_000, true),
      guest("other-a", 14_000, true),
    ]);
    const plans = await planStoredNightPriceRepair({
      task: task("lead", ["other-a"]),
      requested: [
        // The lead absorbs the $40.00 refund: $120.00 - $40.00.
        [
          { date: requireCalendarDate("2026-08-10"), priceCents: 4_000 },
          { date: requireCalendarDate("2026-08-11"), priceCents: 4_000 },
        ],
        // The untouched guest comes to their own $140.00, unmoved.
        [
          { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
          { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
        ],
      ],
      settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
      store,
    });
    expect(plans.map((plan) => plan.bookingGuestId)).toEqual([
      "lead",
      "other-a",
    ]);
  });

  it("MUTATION: refuses a stale screen rather than matching as far as it goes", async () => {
    /*
      The binding is positional, so a request short of the strands the booking
      now has would write one guest's figures onto another guest's nights. A
      length mismatch is a race - a guest repaired or removed in another tab, or
      a client built before #3498 posting the old flat body - and it is refused
      as one, with nothing written.
    */
    mocks.findMany.mockResolvedValue([
      guest("lead", 12_000, true),
      guest("other-a", 14_000, true),
    ]);
    await expect(
      planStoredNightPriceRepair({
        task: task("lead", ["other-a"]),
        requested: [
          [
            { date: requireCalendarDate("2026-08-10"), priceCents: 4_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 4_000 },
          ],
        ],
        settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
