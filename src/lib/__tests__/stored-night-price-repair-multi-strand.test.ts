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
 * THE FIX ROUND ADDS THE THIRD (owner decision, 17 September 2026): a strand
 * whose nights this edit never moved absorbs NOTHING, even when it leads. A pure
 * guest add ranks every existing strand equally, so the lead is a guest nobody
 * touched - and making their blanks come to their stored total PLUS the charge
 * for two newly-added guests writes the new party's money onto an old strand's
 * nights. Where two or more strands DO move, the edit fans out into one item
 * each (`parkedEditWorkItems`) so no item ever has two claims on one amount.
 *
 * MUTATION PROOF. Derive `absorbsSettlement` as "the first repairable strand""
 * instead of "the lead strand, if it is repairable", and
 * "moves NO strand's worth when the strand the money is about has no blanks"
 * fails. Apply the delta to every strand and
 * "every other strand reconciles to its own stored total" fails. Drop the
 * length check and "refuses a stale screen rather than matching as far as it
 * goes" fails. Drop the `editFinancialReviewStrandMovesNights` condition and
 * "a lead the edit never moved absorbs nothing" fails. Change the fan-out
 * threshold from two movers to three and "two moving strands are two work
 * items" fails. All five were applied, all five failed this file, and all five
 * were restored (`docs/TESTING.md`).
 */

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("server-only", () => ({}));

import {
  loadUnpricedNightsSummaries,
  planStoredNightPriceRepair,
  reviewTaskStrands,
} from "@/lib/stored-night-price-repair-plan";
import { requireCalendarDate } from "@/lib/club-time";
import { parkedEditWorkItems } from "@/lib/parked-edit-occurrence";

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
    expect(
      reviewTaskStrands(task("lead", ["other-a", "other-b"])).map(
        (strand) => strand.bookingGuestId,
      ),
    ).toEqual(["lead", "other-a", "other-b"]);
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
      strands: reviewTaskStrands(task("lead", ["other-a", "other-b"])),
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
        {
          strandIndex: 1,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
          ],
        },
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
          {
            strandIndex: 1,
            nightPrices: [
              { date: requireCalendarDate("2026-08-10"), priceCents: 5_000 },
              { date: requireCalendarDate("2026-08-11"), priceCents: 5_000 },
            ],
          },
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
        {
          strandIndex: 0,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 4_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 4_000 },
          ],
        },
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
        {
          strandIndex: 0,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 4_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 4_000 },
          ],
        },
        // The untouched guest comes to their own $140.00, unmoved.
        {
          strandIndex: 1,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
          ],
        },
      ],
      settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
      store,
    });
    expect(plans.map((plan) => plan.bookingGuestId)).toEqual([
      "lead",
      "other-a",
    ]);
  });

  it("MUTATION: refuses figures bound to a strand that is not the one offered", async () => {
    /*
      THE CASE A LENGTH CHECK CANNOT SEE (#3498 fix round, C4). One strand stops
      being repairable while another starts, in the seconds the dialog is open:
      the count is unchanged and every position shifts by one. The blank dates
      and the stored total usually tell the two apart - and on a couple sharing
      the same nights at the same rate they do not, so one guest's figures would
      be written onto the other's nights. Same sum, different nights, and a
      later part-refund is worked out from the nights.

      So each entry names the strand it is for by the item's own ordinal, and a
      set that does not match the offered strands exactly is refused as the race
      it is, with nothing written.
    */
    mocks.findMany.mockResolvedValue([
      guest("lead", 14_000, true),
      guest("other-a", 14_000, true),
    ]);
    await expect(
      planStoredNightPriceRepair({
        task: task("lead", ["other-a"]),
        requested: [
          {
            // The screen offered strands 0 and 1; this names 1 twice.
            strandIndex: 1,
            nightPrices: [
              { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
              { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
            ],
          },
          {
            strandIndex: 1,
            nightPrices: [
              { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
              { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
            ],
          },
        ],
        settled: null,
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
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
          {
            strandIndex: 1,
            nightPrices: [
              { date: requireCalendarDate("2026-08-10"), priceCents: 4_000 },
              { date: requireCalendarDate("2026-08-11"), priceCents: 4_000 },
            ],
          },
        ],
        settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

/**
 * One strand record, with the night movement stated rather than assumed - which
 * is the whole question this block is about.
 */
function strandRecord(
  bookingGuestId: string,
  moves: { surrendered?: readonly string[]; added?: readonly string[] } = {},
) {
  return {
    bookingGuestId,
    cause: "NO_STORED_NIGHT_PRICES" as const,
    surrenderedNightDates: (moves.surrendered ?? []).map(requireCalendarDate),
    addedNightDates: (moves.added ?? []).map(requireCalendarDate),
    storedEvidence: { guestTotalCents: 14_000, nightPrices: [] },
  };
}

function taskOf(strands: readonly ReturnType<typeof strandRecord>[]) {
  const [lead, ...otherStrands] = strands;
  return {
    kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
    reviewContext: {
      version: 1,
      occurrence: {
        bookingId: "booking-1",
        ...lead!,
        ...(otherStrands.length > 0 ? { otherStrands } : {}),
      },
      guestMemberId: null,
      bookingCheckIn: "2026-08-10",
      bookingCheckOut: "2026-08-12",
      bookingModificationId: "mod-1",
    },
  };
}

describe("a strand the edit never moved absorbs nothing (#3498 fix round)", () => {
  it("MUTATION: a PURE GUEST ADD leaves every existing strand at its own stored total", async () => {
    /*
      The shape the fix round closes, and the money is real. Adding two guests at
      $320 each surrenders no night and gains none on any strand already on the
      booking, so every existing strand ranks equally and the lead is decided by
      guest id alone - a guest nobody touched.

      `index === 0` alone made that guest ABSORB the charge: their two blank
      nights would have had to come to their stored $140.00 plus the $640.00 owed
      for two people who are not them. The club would have recorded the new
      party's money against an old guest's stay, and the figure a later
      part-refund is worked out from would have been wrong by $640.00.
    */
    mocks.findMany.mockResolvedValue([guest("a-existing", 14_000, true)]);
    const plans = await planStoredNightPriceRepair({
      task: taskOf([strandRecord("a-existing")]),
      requested: [
        {
          strandIndex: 0,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
          ],
        },
      ],
      // A CHARGE, which is the direction an add settles in.
      settled: { direction: "CHARGE_TO_MEMBER", amountCents: 64_000 },
      store,
    });
    expect(plans.map((plan) => plan.bookingGuestId)).toEqual(["a-existing"]);

    // And the figure that WOULD reconcile if the charge had been absorbed here
    // is refused, which is what makes the case above non-vacuous.
    await expect(
      planStoredNightPriceRepair({
        task: taskOf([strandRecord("a-existing")]),
        requested: [
          {
            strandIndex: 0,
            nightPrices: [
              { date: requireCalendarDate("2026-08-10"), priceCents: 39_000 },
              { date: requireCalendarDate("2026-08-11"), priceCents: 39_000 },
            ],
          },
        ],
        settled: { direction: "CHARGE_TO_MEMBER", amountCents: 64_000 },
        store,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("an EXTENSION absorbs it: nights ADDED move the strand's worth just as nights given back do", async () => {
    /*
      The added-night shape at settle time, which nothing exercised before. A
      strand that GAINS nights against a frozen stored total stops reconciling -
      every new night is written NULL - so it is unpriceable for good, real money
      is owed on it, and the charge for those nights belongs to exactly this
      strand. `editFinancialReviewStrandMovesNights` counts added nights for that
      reason, and a rule written only about surrendered ones would have left the
      extension recorded and unsettleable.

      Stored $140.00 plus the $60.00 being charged is $200.00 across two nights.
    */
    mocks.findMany.mockResolvedValue([guest("extended", 14_000, true)]);
    const plans = await planStoredNightPriceRepair({
      task: taskOf([
        strandRecord("extended", { added: ["2026-08-11"] }),
      ]),
      requested: [
        {
          strandIndex: 0,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 10_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 10_000 },
          ],
        },
      ],
      settled: { direction: "CHARGE_TO_MEMBER", amountCents: 6_000 },
      store,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.entries.map((entry) => entry.priceCents)).toEqual([
      10_000, 10_000,
    ]);
  });
});

describe("how many work items one parked edit raises (#3498 fix round)", () => {
  it("keeps ONE item while at most one strand's nights move", () => {
    // The shape the whole issue is about: removing one guest from a party moves
    // that guest's nights and nobody else's, so the six guests the writer merely
    // rewrote ride along as supporting detail on one card.
    const items = parkedEditWorkItems({
      bookingId: "booking-1",
      strands: [
        strandRecord("departing", { surrendered: ["2026-08-10"] }),
        strandRecord("stayer-a"),
        strandRecord("stayer-b"),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].bookingGuestId).toBe("departing");
    expect(items[0].otherStrands).toHaveLength(2);
  });

  it("MUTATION: two moving strands are two work items, each keeping its own amount", () => {
    /*
      The owner's 17 September decision. An item carries ONE `amountCents`, so
      two strands whose night sets both move cannot share one: the lead would
      absorb the whole settlement and the other would be handed
      `stored + 0 - known` as the total its blanks must come to - which only
      $0.00 satisfies, so closing the review would record sold nights as comped.
      Where the settlement exceeds the lead's blanks that target goes NEGATIVE
      and the review cannot be closed at all.

      A fan-out item carries NO `otherStrands`: the boxes an item offers are the
      blanks of every strand it names, so two items each naming both strands
      would offer every blank twice and let them fight over one night.
    */
    const items = parkedEditWorkItems({
      bookingId: "booking-1",
      strands: [
        strandRecord("mover-a", { surrendered: ["2026-08-10"] }),
        strandRecord("mover-b", { added: ["2026-08-12"] }),
        strandRecord("stayer"),
      ],
    });
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.otherStrands).toBeUndefined();
      expect(item.bookingId).toBe("booking-1");
    }
    expect(items.map((item) => item.bookingGuestId).sort()).toEqual([
      "mover-a",
      "mover-b",
      "stayer",
    ]);
  });

  it("and each fanned item settles only its own strand, absorbing only if that strand moved", async () => {
    /*
      The settle side of the same decision, which is where the money is. Each
      item names ONE strand, so the officer is offered one column per card and
      the amount they settle there moves that strand and no other - which is what
      "each guest keeps their own amount" means in practice.
    */
    mocks.findMany.mockResolvedValue([guest("mover-a", 14_000, true)]);
    const mover = await planStoredNightPriceRepair({
      task: taskOf([strandRecord("mover-a", { surrendered: ["2026-08-10"] })]),
      requested: [
        {
          strandIndex: 0,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 5_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 5_000 },
          ],
        },
      ],
      settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
      store,
    });
    expect(mover.map((plan) => plan.bookingGuestId)).toEqual(["mover-a"]);

    // The item led by the strand nobody moved comes to its stored total flat.
    mocks.findMany.mockResolvedValue([guest("stayer", 14_000, true)]);
    const stayer = await planStoredNightPriceRepair({
      task: taskOf([strandRecord("stayer")]),
      requested: [
        {
          strandIndex: 0,
          nightPrices: [
            { date: requireCalendarDate("2026-08-10"), priceCents: 7_000 },
            { date: requireCalendarDate("2026-08-11"), priceCents: 7_000 },
          ],
        },
      ],
      settled: { direction: "REFUND_TO_MEMBER", amountCents: 4_000 },
      store,
    });
    expect(stayer.map((plan) => plan.bookingGuestId)).toEqual(["stayer"]);
  });
});
