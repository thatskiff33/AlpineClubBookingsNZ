import { describe, expect, it } from "vitest";

import { buildInvoiceLineItems } from "@/lib/xero-booking-invoice-lines";
import { buildGuestInvoiceLines, guestInvoiceLineAmountCents } from "@/lib/booking-guest-invoice-lines";

/**
 * #5066: the Xero guest lines and the app's generated booking invoice cut a
 * guest's stay with ONE run builder (`buildGuestInvoiceLines`, `INV-SSOT`).
 * Moving the runs out of `buildInvoiceLineItems` must not change one byte of
 * what Xero is sent. The expected lines below were captured from the pre-move
 * builder (main at da2c858ec5) for every branch it has: a price change, a gap,
 * an unpriced night (#3170), no night rows, per-guest item codes, and the
 * degenerate zero-night range.
 */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const CHECK_IN = day("2026-07-03");
const CHECK_OUT = day("2026-07-06");

const person = { firstName: "Aroha", lastName: "Smith", ageTier: "ADULT", isMember: true, rateMembershipTypeId: null };

const GUESTS = [
  {
    ...person,
    priceCents: 10000,
    nights: [
      { stayDate: day("2026-07-03"), priceCents: 3000 },
      { stayDate: day("2026-07-04"), priceCents: 3000 },
      { stayDate: day("2026-07-05"), priceCents: 4000 },
    ],
  },
  {
    ...person,
    firstName: "Tama",
    isMember: false,
    priceCents: 5000,
    nights: [
      { stayDate: day("2026-07-03"), priceCents: 2500 },
      { stayDate: day("2026-07-05"), priceCents: 2500 },
    ],
  },
  {
    ...person,
    firstName: "Mere",
    priceCents: 9001,
    nights: [
      { stayDate: day("2026-07-03"), priceCents: 3000 },
      { stayDate: day("2026-07-04"), priceCents: null },
    ],
  },
  { ...person, firstName: "Hemi", ageTier: "CHILD", priceCents: 4500, nights: null },
];

const RESOLVER = {
  byKey: new Map([["type-full_WINTER_ADULT", "HUT-W-A"]]),
  fullTypeId: "type-full",
  nonMemberTypeId: "type-non-member",
  legacyItemCode: "HUT-L",
  size: 1,
} as unknown as Parameters<typeof buildInvoiceLineItems>[7];

type Expected = { d: string; q: number; u: number; item?: string };
const line = ({ d, q, u, item }: Expected, accountCode = "200") => ({
  description: d,
  quantity: q,
  unitAmount: u,
  taxType: "OUTPUT2",
  ...(item ? { itemCode: item } : {}),
  accountCode,
});

const RUNS: Array<Omit<Expected, "item"> & { coded: boolean }> = [
  { d: "Aroha Smith - (ADULT, Member) - 2 nights - 2026-07-03 - 2026-07-05", q: 2, u: 30, coded: true },
  { d: "Aroha Smith - (ADULT, Member) - 1 night - 2026-07-05 - 2026-07-06", q: 1, u: 40, coded: true },
  { d: "Tama Smith - (ADULT, Non-member) - 1 night - 2026-07-03 - 2026-07-04", q: 1, u: 25, coded: false },
  { d: "Tama Smith - (ADULT, Non-member) - 1 night - 2026-07-05 - 2026-07-06", q: 1, u: 25, coded: false },
  { d: "Mere Smith - (ADULT, Member) - 1 night - 2026-07-03 - 2026-07-04", q: 1, u: 30.01, coded: true },
  { d: "Mere Smith - (ADULT, Member) - 2 nights - 2026-07-04 - 2026-07-06", q: 2, u: 30, coded: true },
  { d: "Hemi Smith - (CHILD, Member) - 3 nights - 2026-07-03 - 2026-07-06", q: 3, u: 15, coded: false },
];

describe("buildInvoiceLineItems after the run builder moved out (#5066)", () => {
  it("sends Xero the pre-move lines with one flat item code", () => {
    const lines = buildInvoiceLineItems(GUESTS, CHECK_IN, CHECK_OUT, 3, "200", "HUT", true);
    expect(JSON.stringify(lines)).toBe(JSON.stringify(RUNS.map((run) => line({ ...run, item: "HUT" }))));
  });

  it("sends Xero the pre-move lines with no item code", () => {
    const lines = buildInvoiceLineItems(GUESTS, CHECK_IN, CHECK_OUT, 3);
    expect(JSON.stringify(lines)).toBe(JSON.stringify(RUNS.map((run) => line(run))));
  });

  it("sends Xero the pre-move lines with per-guest item codes", () => {
    const lines = buildInvoiceLineItems(GUESTS, CHECK_IN, CHECK_OUT, 3, "200", "HUT", true, RESOLVER, "WINTER");
    expect(JSON.stringify(lines)).toBe(
      JSON.stringify(RUNS.map((run) => line({ ...run, item: run.coded ? "HUT-W-A" : undefined }))),
    );
  });

  it("keeps the degenerate zero-night line: quantity 0 at the flat price over the booking's range", () => {
    const zero = { d: "Aroha Smith - (ADULT, Member) - 0 nights - 2026-07-03 - 2026-07-03", q: 0, u: 70 };
    expect(JSON.stringify(buildInvoiceLineItems([{ ...person, priceCents: 7000, nights: null }], CHECK_IN, CHECK_IN, 0))).toBe(
      JSON.stringify([line(zero)]),
    );
    expect(
      JSON.stringify(
        buildInvoiceLineItems([{ ...person, priceCents: 7000, nights: [] }], CHECK_IN, CHECK_IN, 0, "201", null, false, RESOLVER, null),
      ),
    ).toBe(JSON.stringify([line(zero, "201")]));
  });

  it("bills exactly the runs the shared builder cuts, at the same cents", () => {
    const runs = buildGuestInvoiceLines(GUESTS, CHECK_IN, CHECK_OUT, 3);
    const lines = buildInvoiceLineItems(GUESTS, CHECK_IN, CHECK_OUT, 3);
    expect(lines.map((item) => Math.round((item.quantity ?? 0) * (item.unitAmount ?? 0) * 100))).toEqual(
      runs.map(guestInvoiceLineAmountCents),
    );
  });
});
