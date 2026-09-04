import { describe, expect, it, vi } from "vitest";

// The store half is `server-only`; the rules half is not, which is the whole
// point of the split. Both are exercised here because the acceptance criterion
// is about what the DATA looks like afterwards, not about either half alone.
vi.mock("server-only", () => ({}));

import { requireCalendarDate } from "@/lib/club-time";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";
import {
  checkStoredNightPriceRepair,
  settlementDeltaCents,
  NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE,
  NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE,
  NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
  NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";
import {
  applyStoredNightPriceRepair,
  applyStrandNightPriceReconcile,
  unpricedNightsSummaryForGuest,
  NIGHT_PRICE_REPAIR_RACED_MESSAGE,
} from "@/lib/stored-night-price-repair-store";

/**
 * #3191 (epic #2797): the rules for filling in a night whose sold price is not
 * known, and the property the whole issue exists to buy.
 *
 * THE ACCEPTANCE CRITERION THIS FILE IS ABOUT is the third one on #3191: "a
 * booking whose blanks are all cleared must stop parking on subsequent edits,
 * and there must be a test proving it". That proof is the last describe block,
 * and it is deliberately not a re-statement of the arithmetic above it: it takes
 * a strand the exactness classifier calls `unusable`, runs the real writer over
 * a store that enforces the same fences the database does, and asks the SAME
 * classifier again.
 *
 * The two guards `INV-MOD-028` demands - no derivation, and a reconciliation
 * before anything is accepted - are mutation-verified in the first two blocks.
 */

const nights = (dates: readonly string[]) => dates.map(requireCalendarDate);

function summaryOf(
  dates: readonly string[],
  knownNightTotalCents: number,
  storedGuestTotalCents: number,
): UnpricedNightsSummary {
  return {
    dates: nights(dates),
    knownNightTotalCents,
    storedGuestTotalCents,
  };
}

describe("no blank is ever filled in for the officer (INV-MOD-028)", () => {
  const summary = summaryOf(["2026-08-01", "2026-08-02"], 0, 10_000);

  it("refuses a partial answer rather than working the rest out", () => {
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [{ date: requireCalendarDate("2026-08-01"), priceCents: 5_000 }],
      deltaCents: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe(
      NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE,
    );
  });

  it("refuses one date typed twice standing in for the other", () => {
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 5_000 },
        { date: requireCalendarDate("2026-08-01"), priceCents: 5_000 },
      ],
      deltaCents: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe(
      NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE,
    );
  });

  it("refuses a night this strand does not hold blank", () => {
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 5_000 },
        { date: requireCalendarDate("2026-08-09"), priceCents: 5_000 },
      ],
      deltaCents: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe(
      NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE,
    );
  });

  it("refuses an amount that is not whole non-negative cents", () => {
    for (const priceCents of [-1, 12.5]) {
      const result = checkStoredNightPriceRepair({
        summary,
        entries: [
          { date: requireCalendarDate("2026-08-01"), priceCents },
          { date: requireCalendarDate("2026-08-02"), priceCents: 5_000 },
        ],
        deltaCents: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toBe(
        NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE,
      );
    }
  });

  it("accepts a genuine zero, which is a real sold price and not a blank", () => {
    // THE CONTROL for the amount refusal above. A comped night stores 0, and a
    // rule that refused it would have made the epic's own distinction
    // unrepresentable in the one screen that can restore it.
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 0 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 10_000 },
      ],
      deltaCents: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("has nothing to accept when the strand has no blanks", () => {
    const result = checkStoredNightPriceRepair({
      summary: summaryOf([], 10_000, 10_000),
      entries: [],
      deltaCents: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe(
      NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
    );
  });
});

describe("the figures must reconcile to the amount being settled", () => {
  const summary = summaryOf(["2026-08-01", "2026-08-02"], 3_000, 10_000);

  it("accepts a dismissal whose nights come to the stored total unchanged", () => {
    // THE CONTROL. Nothing moves, so the blanks make up the difference between
    // the priced nights and what the strand is already stored as being worth.
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 4_000 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 3_000 },
      ],
      deltaCents: settlementDeltaCents(null),
    });
    expect(result.ok).toBe(true);
    expect(result.targetCents).toBe(7_000);
  });

  it("refuses figures that do not come to the target, and says the target", () => {
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 4_000 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 3_001 },
      ],
      deltaCents: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("$70.01");
    expect(result.ok === false && result.message).toContain("$70.00");
    /*
      #3191 fix round: AND it offers the third way out. The two obvious ones -
      change the figures, change the settlement - are arithmetically forced, and
      on a settlement that is not simply what the nights were worth (an admin
      fee kept back, a hand-back reduced by policy) the only figure that
      satisfies this check is FALSE. An officer steered towards nothing else
      types it, and that is the unprovenanced number epic #2797 exists to
      remove. `docs/guides/payments.md` says leaving them blank is fine; the
      refusal has to say it at the moment the decision is made.
    */
    expect(result.ok === false && result.message).toMatch(
      /clear every box and settle without them/,
    );
    /*
      #3191 fix round, second pass: AND IT LEADS WITH IT. The clause used to sit
      at the end of a 480-character paragraph an officer reads in `text-xs`,
      behind "Change the night amounts, or the settlement figure" - so the person
      facing exactly the case this sentence was extended for was told first to do
      the thing that produces a false price. `docs/guides/payments.md` leads with
      the opposite emphasis, and a screen that disagrees with the guide on this
      one sentence is worse than a screen that says nothing.

      Order asserted, not just presence: it is the ORDER that was wrong.
    */
    const message = result.ok === false ? result.message : "";
    expect(message.indexOf("clear every box")).toBeLessThan(
      message.indexOf("Otherwise correct whichever figure is wrong"),
    );
    // And the guide's corrective reaches the officer who is being told to change
    // a figure, rather than being left in the guide.
    expect(message).toMatch(
      /do not change a night's price to make the arithmetic work/,
    );
  });

  it("says the same when no set of prices could satisfy it at all", () => {
    // A refund larger than everything the blanks could be worth. There is no
    // figure to type here, so a refusal that named only the two forced options
    // would be a dead end.
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 0 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 0 },
      ],
      deltaCents: settlementDeltaCents({
        direction: "REFUND_TO_MEMBER",
        amountCents: 9_000,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.targetCents).toBe(-2_000);
    expect(result.ok === false && result.message).toMatch(
      /clear every box and settle without them/,
    );
  });

  it("takes a refund off what the stay is worth and adds a charge to it", () => {
    // The sign is the whole of `settlementDeltaCents`, and getting it backwards
    // is the failure #3170 spent a whole child preventing on the money itself.
    expect(
      settlementDeltaCents({ direction: "REFUND_TO_MEMBER", amountCents: 2_500 }),
    ).toBe(-2_500);
    expect(
      settlementDeltaCents({ direction: "CHARGE_TO_MEMBER", amountCents: 2_500 }),
    ).toBe(2_500);

    const refunded = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 2_500 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 2_000 },
      ],
      deltaCents: settlementDeltaCents({
        direction: "REFUND_TO_MEMBER",
        amountCents: 2_500,
      }),
    });
    expect(refunded.ok).toBe(true);
    expect(refunded.targetCents).toBe(4_500);

    const charged = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 5_000 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 4_500 },
      ],
      deltaCents: settlementDeltaCents({
        direction: "CHARGE_TO_MEMBER",
        amountCents: 2_500,
      }),
    });
    expect(charged.ok).toBe(true);
    expect(charged.targetCents).toBe(9_500);
  });

  it("says so plainly when no set of prices could satisfy the settlement", () => {
    const result = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 0 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 0 },
      ],
      deltaCents: settlementDeltaCents({
        direction: "REFUND_TO_MEMBER",
        amountCents: 20_000,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      "cannot be shared out as prices",
    );
  });
});

/**
 * A guest strand and the two writes this feature makes, with the SAME fences the
 * database applies: a night is matched only while its price is still blank, and
 * the strand's total only while it still holds the value that was read.
 *
 * Written as a fake rather than mocked call-by-call because what is being proved
 * is a property of the DATA after the write - which a `toHaveBeenCalledWith`
 * assertion cannot see at all.
 */
function guestStore(guest: {
  id: string;
  priceCents: number;
  nights: Array<{ stayDate: Date; priceCents: number | null }>;
}) {
  return {
    guest,
    store: {
      bookingGuest: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === guest.id ? guest : null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; priceCents?: number };
          data: { priceCents: number };
        }) => {
          // The `where` is applied FIELD BY FIELD, exactly as the database would,
          // and a fence the caller omits is therefore a fence that is not
          // applied. Reproducing the fence inside the fake instead would make
          // this suite pass for a writer that had dropped it - which it did,
          // until a mutation probe caught it.
          if (where.id !== guest.id) return { count: 0 };
          if ("priceCents" in where && where.priceCents !== guest.priceCents) {
            return { count: 0 };
          }
          guest.priceCents = data.priceCents;
          return { count: 1 };
        },
      },
      bookingGuestNight: {
        updateMany: async ({
          where,
          data,
        }: {
          where: {
            bookingGuestId: string;
            stayDate: Date;
            priceCents?: null;
          };
          data: { priceCents: number };
        }) => {
          if (where.bookingGuestId !== guest.id) return { count: 0 };
          const night = guest.nights.find(
            (row) =>
              row.stayDate.getTime() === where.stayDate.getTime() &&
              (!("priceCents" in where) || row.priceCents === where.priceCents),
          );
          if (!night) return { count: 0 };
          night.priceCents = data.priceCents;
          return { count: 1 };
        },
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asStore = (store: unknown) => store as any;

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

const booking = { checkIn: day("2026-08-01"), checkOut: day("2026-08-03") };

describe("which strands can be repaired at all", () => {
  it("offers the blanks, the priced total and the stored total", () => {
    expect(
      unpricedNightsSummaryForGuest({
        id: "g1",
        priceCents: 10_000,
        nights: [
          { stayDate: day("2026-08-02"), priceCents: null },
          { stayDate: day("2026-08-01"), priceCents: 3_000 },
        ],
      }),
    ).toEqual({
      dates: nights(["2026-08-02"]),
      knownNightTotalCents: 3_000,
      storedGuestTotalCents: 10_000,
    });
  });

  it("offers nothing where there is nothing to fill in", () => {
    expect(
      unpricedNightsSummaryForGuest({
        id: "g1",
        priceCents: 6_000,
        nights: [
          { stayDate: day("2026-08-01"), priceCents: 3_000 },
          { stayDate: day("2026-08-02"), priceCents: 3_000 },
        ],
      }),
    ).toBeNull();
  });

  it("offers nothing where filling the blanks would not make the strand exact", () => {
    // A negative stored row is an absence of usable evidence too, but it is not
    // NULL - so this path's fence cannot reach it and the strand would still not
    // reconcile afterwards. Promising a repair that does not repair is worse
    // than offering none; those rows are #2745's audited decision.
    expect(
      unpricedNightsSummaryForGuest({
        id: "g1",
        priceCents: 6_000,
        nights: [
          { stayDate: day("2026-08-01"), priceCents: -100 },
          { stayDate: day("2026-08-02"), priceCents: null },
        ],
      }),
    ).toBeNull();
    // And a strand carrying no night rows at all: its held nights come from the
    // stay envelope, so there is no row to update.
    expect(
      unpricedNightsSummaryForGuest({ id: "g1", priceCents: 6_000, nights: [] }),
    ).toBeNull();
  });
});

describe("a booking whose blanks are all cleared stops parking (#3191)", () => {
  it("turns an unusable strand into an exact one, end to end", async () => {
    const fixture = {
      id: "g1",
      priceCents: 10_000,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    };
    const { guest, store } = guestStore(fixture);

    // BEFORE: the classifier every edit path consults sends this strand to a
    // person, which is why the booking parks.
    expect(storedSoldPriceEvidenceForGuest(guest, booking).kind).toBe(
      "unusable",
    );

    const summary = unpricedNightsSummaryForGuest(guest);
    expect(summary).not.toBeNull();
    const check = checkStoredNightPriceRepair({
      summary: summary!,
      entries: [{ date: requireCalendarDate("2026-08-02"), priceCents: 6_000 }],
      deltaCents: 0,
    });
    expect(check.ok).toBe(true);

    const { newGuestTotalCents } = await applyStoredNightPriceRepair({
      bookingGuestId: guest.id,
      summary: summary!,
      entries: check.ok ? check.entries : [],
      store: asStore(store),
    });

    // AFTER: the same classifier, on the same strand, now prices it exactly - so
    // the next edit is answered from stored evidence instead of parking.
    expect(newGuestTotalCents).toBe(10_000);
    const after = storedSoldPriceEvidenceForGuest(guest, booking);
    expect(after.kind).toBe("exact");
    expect(after.kind === "exact" && after.totalCents).toBe(10_000);
  });

  it("re-bases what the strand is worth when the settlement moved it", async () => {
    const { guest, store } = guestStore({
      id: "g1",
      priceCents: 10_000,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: null },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const summary = unpricedNightsSummaryForGuest(guest)!;
    const deltaCents = settlementDeltaCents({
      direction: "CHARGE_TO_MEMBER",
      amountCents: 4_000,
    });
    const check = checkStoredNightPriceRepair({
      summary,
      entries: [
        { date: requireCalendarDate("2026-08-01"), priceCents: 7_000 },
        { date: requireCalendarDate("2026-08-02"), priceCents: 7_000 },
      ],
      deltaCents,
    });
    expect(check.ok).toBe(true);

    const { newGuestTotalCents } = await applyStoredNightPriceRepair({
      bookingGuestId: guest.id,
      summary,
      entries: check.ok ? check.entries : [],
      store: asStore(store),
    });
    expect(newGuestTotalCents).toBe(14_000);
    expect(guest.priceCents).toBe(14_000);
    expect(storedSoldPriceEvidenceForGuest(guest, booking).kind).toBe("exact");
  });
});

describe("the settle path's write is UNCHANGED by #3214's generalised writer", () => {
  it("reaches the database with the same fenced arguments it always did", async () => {
    /*
      #3214 generalised this writer so a second caller could share it: the night
      fence became "the value the row was read holding" rather than a literal
      `priceCents: null`, and a create arm was added for a night the strand holds
      with no row behind it.

      NEITHER CAN REACH THIS PATH, and that is a property of how the settle plan
      is built rather than a rule anybody has to keep:
      `unpricedNightsSummaryForGuest` takes its dates only from rows this strand
      ALREADY has whose price is exactly `NULL`, so every entry is an existing
      row expected to be blank.

      So this pins the arguments byte for byte - the `where` including its
      `priceCents: null`, and no `create` at all - which is what lets a reviewer
      see the settle path is untouched without re-reading the writer.
    */
    const nightUpdateMany = vi.fn(async () => ({ count: 1 }));
    const nightCreate = vi.fn(async () => ({ id: "night-1" }));
    const guestUpdateMany = vi.fn(async () => ({ count: 1 }));
    const store = {
      bookingGuestNight: { updateMany: nightUpdateMany, create: nightCreate },
      bookingGuest: { updateMany: guestUpdateMany },
    };

    await applyStoredNightPriceRepair({
      bookingGuestId: "guest-1",
      summary: summaryOf(["2026-08-02"], 4_000, 10_000),
      entries: [{ date: requireCalendarDate("2026-08-02"), priceCents: 8_000 }],
      store: asStore(store),
    });

    expect(nightUpdateMany).toHaveBeenCalledTimes(1);
    expect(nightUpdateMany).toHaveBeenCalledWith({
      where: {
        bookingGuestId: "guest-1",
        stayDate: new Date("2026-08-02T00:00:00.000Z"),
        priceCents: null,
      },
      data: { priceCents: 8_000 },
    });
    expect(nightCreate).not.toHaveBeenCalled();
    expect(guestUpdateMany).toHaveBeenCalledWith({
      where: { id: "guest-1", priceCents: 10_000 },
      data: { priceCents: 12_000 },
    });
  });
});

describe("the writes cannot overwrite a price somebody else recorded", () => {
  it("refuses when a night stopped being blank underneath it", async () => {
    const { guest, store } = guestStore({
      id: "g1",
      priceCents: 10_000,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const summary = unpricedNightsSummaryForGuest(guest)!;
    // Somebody else priced it between the read and the write.
    guest.nights[1].priceCents = 5_500;

    await expect(
      applyStoredNightPriceRepair({
        bookingGuestId: guest.id,
        summary,
        entries: [
          { date: requireCalendarDate("2026-08-02"), priceCents: 6_000 },
        ],
        store: asStore(store),
      }),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_RACED_MESSAGE);
    // And the value they recorded is still theirs.
    expect(guest.nights[1].priceCents).toBe(5_500);
  });

  it("refuses when the strand's stored total moved underneath it", async () => {
    const { guest, store } = guestStore({
      id: "g1",
      priceCents: 10_000,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const summary = unpricedNightsSummaryForGuest(guest)!;
    guest.priceCents = 12_000;

    await expect(
      applyStoredNightPriceRepair({
        bookingGuestId: guest.id,
        summary,
        entries: [
          { date: requireCalendarDate("2026-08-02"), priceCents: 6_000 },
        ],
        store: asStore(store),
      }),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_RACED_MESSAGE);
  });
});

describe("the money-neutrality promise belongs to the writer (#3214 review)", () => {
  /*
    `applyStrandNightPriceReconcile` is EXPORTED and takes an arbitrary
    `summary` and `writes`, so a second caller could hand it a set that re-bases
    the strand's total to a different number - and the function's name would
    still be promising it had not. The check therefore sits inside the writer
    rather than in `recordStrandNightPriceReconcile`, and this drives it the way
    a second caller would: directly, with no plan in front of it.
  */
  it("refuses a set that would move what the stay is stored as being worth", async () => {
    const { guest, store } = guestStore({
      id: "g1",
      priceCents: 10_000,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 6_000 },
      ],
    });

    await expect(
      applyStrandNightPriceReconcile({
        bookingGuestId: guest.id,
        summary: {
          dates: [
            requireCalendarDate("2026-08-01"),
            requireCalendarDate("2026-08-02"),
          ],
          knownNightTotalCents: 0,
          storedGuestTotalCents: 10_000,
        },
        // $150 against a stay stored at $100: exactly the re-base the name
        // promises cannot happen.
        writes: [
          {
            date: requireCalendarDate("2026-08-01"),
            priceCents: 9_000,
            expectedPriceCents: 4_000,
            rowExists: true,
          },
          {
            date: requireCalendarDate("2026-08-02"),
            priceCents: 6_000,
            expectedPriceCents: 6_000,
            rowExists: true,
          },
        ],
        store: asStore(store),
      }),
    ).rejects.toThrow(/may never do/);
  });

  it("accepts a set that re-apportions within the same total", async () => {
    // THE CONTROL. Without it the refusal above could be passing because the
    // writer refuses everything.
    const { guest, store } = guestStore({
      id: "g1",
      priceCents: 10_000,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 6_000 },
      ],
    });

    const { newGuestTotalCents } = await applyStrandNightPriceReconcile({
      bookingGuestId: guest.id,
      summary: {
        dates: [
          requireCalendarDate("2026-08-01"),
          requireCalendarDate("2026-08-02"),
        ],
        knownNightTotalCents: 0,
        storedGuestTotalCents: 10_000,
      },
      writes: [
        {
          date: requireCalendarDate("2026-08-01"),
          priceCents: 0,
          expectedPriceCents: 4_000,
          rowExists: true,
        },
        {
          date: requireCalendarDate("2026-08-02"),
          priceCents: 10_000,
          expectedPriceCents: 6_000,
          rowExists: true,
        },
      ],
      store: asStore(store),
    });

    expect(newGuestTotalCents).toBe(10_000);
    expect(guest.priceCents).toBe(10_000);
    expect(guest.nights.map((night) => night.priceCents)).toEqual([0, 10_000]);
  });
});
