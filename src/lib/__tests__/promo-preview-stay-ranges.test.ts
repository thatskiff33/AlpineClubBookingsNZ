/**
 * #4199: the promo preview prices each guest on the nights the save will price,
 * by handing the party to the modification planner (`INV-EXCEPT-022`) on an
 * edit, and normalising each guest on their own for a create.
 *
 * Frozen clock discipline: every date is a fixed lodge night after the
 * 2026-07-01 freeze; nothing reads the real calendar.
 */
import { describe, expect, it } from "vitest";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { BookingGuestStayRangeValidationError } from "@/lib/booking-guest-stay-range-input";
import { resolvePromoPreviewStays, type PromoPreviewStayGuest } from "@/lib/promo-preview-stay-ranges";

const d = parseDateOnly;
const keys = (nights: Date[] | undefined) => nights?.map(formatDateOnly);

/** A booking of 10-13 August whose guest "bg-gap" holds the 10th and 12th only. */
const booking = { checkIn: d("2026-08-10"), checkOut: d("2026-08-13") };
const storedGuests = [
  {
    id: "bg-full",
    memberId: "booker",
    stayStart: d("2026-08-10"),
    stayEnd: d("2026-08-13"),
    // #4317: a stored guest carries its total and each night its price and
    // provenance; three nights at $40 add up to the $120 total (R1).
    priceCents: 12000,
    nights: ["2026-08-10", "2026-08-11", "2026-08-12"].map((night) => ({
      stayDate: d(night),
      priceCents: 4000,
      priceSource: "SOLD" as const,
    })),
  },
  {
    id: "bg-gap",
    memberId: null,
    stayStart: d("2026-08-10"),
    stayEnd: d("2026-08-13"),
    // Two held nights at $40 add up to the $80 total (R1).
    priceCents: 8000,
    nights: ["2026-08-10", "2026-08-12"].map((night) => ({
      stayDate: d(night),
      priceCents: 4000,
      priceSource: "SOLD" as const,
    })),
  },
];
const BOOKER = { memberId: "booker", bookingGuestId: "bg-full" };
const GAPPED = { bookingGuestId: "bg-gap" };

function resolveEdit(
  guests: PromoPreviewStayGuest[],
  dates: { checkIn: string; checkOut: string } = { checkIn: "2026-08-10", checkOut: "2026-08-13" },
) {
  return resolvePromoPreviewStays({
    checkIn: d(dates.checkIn),
    checkOut: d(dates.checkOut),
    guests,
    edit: { booking, storedGuests },
  });
}

describe("an edit preview resolves stays through the modification planner", () => {
  it("grid mode: a guest's chosen nights are the nights priced, gap and all", () => {
    const resolved = resolveEdit([
      { ...BOOKER, nights: ["2026-08-10", "2026-08-11", "2026-08-12"] },
      { ...GAPPED, nights: ["2026-08-12", "2026-08-10"] },
    ]);
    expect(keys(resolved.guests[1]!.nights)).toEqual(["2026-08-10", "2026-08-12"]);
    expect(formatDateOnly(resolved.guests[1]!.stayStart)).toBe("2026-08-10");
    expect(formatDateOnly(resolved.guests[1]!.stayEnd)).toBe("2026-08-13");
  });

  it("grid mode: the envelope is the one the save would write, wherever the request's dates were", () => {
    const resolved = resolveEdit(
      [
        { ...BOOKER, nights: ["2026-08-11"] },
        { ...GAPPED, nights: ["2026-08-12", "2026-08-14"] },
      ],
      { checkIn: "2026-08-10", checkOut: "2026-08-13" },
    );
    expect(formatDateOnly(resolved.checkIn)).toBe("2026-08-11");
    expect(formatDateOnly(resolved.checkOut)).toBe("2026-08-15");
  });

  it("range mode is unchanged: a gapped guest sent continuous dates is priced continuously (#4189)", () => {
    const resolved = resolveEdit([
      { ...BOOKER, stayStart: "2026-08-10", stayEnd: "2026-08-13" },
      { ...GAPPED, stayStart: "2026-08-10", stayEnd: "2026-08-13" },
    ]);
    expect(resolved.guests[1]!.nights).toBeUndefined();
    expect(formatDateOnly(resolved.guests[1]!.stayStart)).toBe("2026-08-10");
    expect(formatDateOnly(resolved.guests[1]!.stayEnd)).toBe("2026-08-13");
  });

  it("with no ranges sent and the dates unmoved, each guest keeps their stored nights, as the save does", () => {
    const resolved = resolveEdit([BOOKER, GAPPED]);
    expect(keys(resolved.guests[1]!.nights)).toEqual(["2026-08-10", "2026-08-12"]);
  });

  it("with no ranges sent and the dates moved, every guest is reset to the new dates, as the save does", () => {
    const resolved = resolveEdit([BOOKER, GAPPED], { checkIn: "2026-08-11", checkOut: "2026-08-14" });
    expect(resolved.guests[1]!.nights).toBeUndefined();
    expect(formatDateOnly(resolved.guests[1]!.stayStart)).toBe("2026-08-11");
    expect(formatDateOnly(resolved.guests[1]!.stayEnd)).toBe("2026-08-14");
  });

  it("a guest being added (no row) is resolved as an added guest, in party order", () => {
    const resolved = resolveEdit([
      { ...BOOKER, nights: ["2026-08-10"] },
      { memberId: "friend", nights: ["2026-08-11", "2026-08-12"] },
      { ...GAPPED, nights: ["2026-08-12"] },
    ]);
    expect(resolved.guests.map((guest) => keys(guest.nights))).toEqual([
      ["2026-08-10"],
      ["2026-08-11", "2026-08-12"],
      ["2026-08-12"],
    ]);
    expect(resolved.guests[1]!.memberId).toBe("friend");
  });

  it("a row named beside a different member is not that row: the guest is an added guest", () => {
    // Range-less, so a remaining guest would keep the row's stored gap; an
    // added guest takes the booking's dates instead.
    const resolved = resolveEdit([BOOKER, { memberId: "stranger", bookingGuestId: "bg-gap" }]);
    expect(resolved.guests[1]!.nights).toBeUndefined();
    expect(formatDateOnly(resolved.guests[1]!.stayStart)).toBe("2026-08-10");
  });

  it("only the first guest naming a row claims it", () => {
    const resolved = resolveEdit([BOOKER, GAPPED, GAPPED]);
    expect(keys(resolved.guests[1]!.nights)).toEqual(["2026-08-10", "2026-08-12"]);
    expect(resolved.guests[2]!.nights).toBeUndefined();
  });

  it("refuses an invalid range with the planner's own error", () => {
    expect(() =>
      resolveEdit([{ ...BOOKER, stayStart: "2026-08-12", stayEnd: "2026-08-11" }, GAPPED]),
    ).toThrow(BookingGuestStayRangeValidationError);
  });
});

describe("a create preview normalises each guest on their own", () => {
  it("keeps a guest's night set and the request's dates", () => {
    const resolved = resolvePromoPreviewStays({
      checkIn: d("2026-08-10"),
      checkOut: d("2026-08-13"),
      guests: [{ nights: ["2026-08-10", "2026-08-12"] }, {}],
      edit: null,
    });
    expect(keys(resolved.guests[0]!.nights)).toEqual(["2026-08-10", "2026-08-12"]);
    expect(formatDateOnly(resolved.guests[1]!.stayStart)).toBe("2026-08-10");
    expect(formatDateOnly(resolved.guests[1]!.stayEnd)).toBe("2026-08-13");
    expect(formatDateOnly(resolved.checkIn)).toBe("2026-08-10");
    expect(formatDateOnly(resolved.checkOut)).toBe("2026-08-13");
  });
});

/**
 * #4202: a guest already on the booking prices with the locks the quote and the
 * save price them with (`editedGuestPricingLocks`, #1036): each night they
 * bought keeps its sold price. An added guest, a guest whose row belongs to
 * another member, and a create preview carry none.
 */
describe("an edit preview carries each remaining guest's sold prices (#4202)", () => {
  const SOLD = 4000;
  const ODD_TOTAL = 8000;
  const soldGuests = [
    {
      id: "bg-sold",
      memberId: "booker",
      stayStart: d("2026-08-10"),
      stayEnd: d("2026-08-13"),
      priceCents: SOLD * 3,
      nights: ["2026-08-10", "2026-08-11", "2026-08-12"].map((night) => ({
        stayDate: d(night),
        priceCents: SOLD,
        priceSource: "SOLD" as const,
      })),
    },
    {
      id: "bg-odd",
      memberId: null,
      stayStart: d("2026-08-10"),
      stayEnd: d("2026-08-12"),
      priceCents: ODD_TOTAL,
      // A night with no known sold price and one that cannot be money: neither
      // row is usable, so each night takes its share of the stored total (R2,
      // #4317 / INV-MOD-028) rather than today's rate.
      nights: [
        { stayDate: d("2026-08-10"), priceCents: null, priceSource: "SOLD" as const },
        { stayDate: d("2026-08-11"), priceCents: -1, priceSource: "SOLD" as const },
      ],
    },
  ];
  const resolveSold = (guests: PromoPreviewStayGuest[]) =>
    resolvePromoPreviewStays({
      checkIn: d("2026-08-10"),
      checkOut: d("2026-08-14"),
      guests,
      edit: { booking, storedGuests: soldGuests },
    });
  const lockKeys = (locks: ReadonlyArray<{ stayDate: Date; priceCents: number }> | undefined) =>
    locks?.map((lock) => [formatDateOnly(lock.stayDate), lock.priceCents]);

  it("a remaining guest keeps the sold price of every night they hold", () => {
    const resolved = resolveSold([
      { memberId: "booker", bookingGuestId: "bg-sold", stayStart: "2026-08-10", stayEnd: "2026-08-14" },
    ]);
    expect(lockKeys(resolved.guests[0]!.lockedNightPrices)).toEqual([
      ["2026-08-10", SOLD],
      ["2026-08-11", SOLD],
      ["2026-08-12", SOLD],
    ]);
  });

  it("a night with no usable sold price is locked at its share of the stored total (#4317)", () => {
    const resolved = resolveSold([{ bookingGuestId: "bg-odd", stayStart: "2026-08-10", stayEnd: "2026-08-12" }]);
    // R2: $80 stored, no usable rows ($0 kept), so the $80 splits over the two
    // unvalued nights: $40 each. Before #4317 these nights were not locked.
    expect(lockKeys(resolved.guests[0]!.lockedNightPrices)).toEqual([
      ["2026-08-10", 4000],
      ["2026-08-11", 4000],
    ]);
  });

  it("an added guest, and a row named beside a different member, carry no locks", () => {
    const resolved = resolveSold([
      { memberId: "friend", stayStart: "2026-08-10", stayEnd: "2026-08-14" },
      { memberId: "stranger", bookingGuestId: "bg-sold", stayStart: "2026-08-10", stayEnd: "2026-08-14" },
    ]);
    expect(resolved.guests[0]!.lockedNightPrices).toBeUndefined();
    expect(resolved.guests[1]!.lockedNightPrices).toBeUndefined();
  });

  it("locks come from the stored row, never from the request", () => {
    const sent = [{ stayDate: d("2026-08-10"), priceCents: 1 }];
    const resolved = resolveSold([
      { memberId: "friend", stayStart: "2026-08-10", stayEnd: "2026-08-14", lockedNightPrices: sent } as PromoPreviewStayGuest,
      { memberId: "booker", bookingGuestId: "bg-sold", lockedNightPrices: sent } as PromoPreviewStayGuest,
    ]);
    expect(resolved.guests[0]!.lockedNightPrices).toBeUndefined();
    expect(lockKeys(resolved.guests[1]!.lockedNightPrices)?.[0]).toEqual(["2026-08-10", SOLD]);
  });

  it("a remaining guest keeps the row's other-lodge flag; an added guest has none", () => {
    const resolved = resolvePromoPreviewStays({
      checkIn: d("2026-08-10"),
      checkOut: d("2026-08-14"),
      guests: [{ bookingGuestId: "bg-visitor" }, { memberId: "friend" }],
      edit: {
        booking,
        storedGuests: [{ ...soldGuests[1]!, id: "bg-visitor", otherLodgeMember: true }],
      },
    });
    expect(resolved.guests[0]!.otherLodgeMember).toBe(true);
    expect(resolved.guests[1]!.otherLodgeMember).toBeUndefined();
  });

  it("a guest the edit re-rates has no locks, and a linked placeholder prices as the member (#4202 review)", () => {
    const resolved = resolvePromoPreviewStays({
      checkIn: d("2026-08-10"),
      checkOut: d("2026-08-14"),
      guests: [{ memberId: "booker", bookingGuestId: "bg-sold" }, { bookingGuestId: "bg-odd" }],
      edit: {
        booking,
        storedGuests: [
          { ...soldGuests[0]!, repricedDeliberately: true },
          { ...soldGuests[1]!, linkedMemberId: "m9", repricedDeliberately: true },
        ],
      },
    });
    expect(resolved.guests[0]!.lockedNightPrices).toEqual([]);
    expect(resolved.guests[0]!.memberId).toBe("booker");
    expect(resolved.guests[1]!.lockedNightPrices).toEqual([]);
    expect(resolved.guests[1]!).toMatchObject({ memberId: "m9", isMember: true });
  });

  it("a create preview carries no locks", () => {
    const resolved = resolvePromoPreviewStays({
      checkIn: d("2026-08-10"),
      checkOut: d("2026-08-13"),
      guests: [{ memberId: "booker" }],
      edit: null,
    });
    expect(resolved.guests[0]!).not.toHaveProperty("lockedNightPrices");
  });
});
