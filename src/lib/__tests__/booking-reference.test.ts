import { describe, expect, it } from "vitest";

import {
  buildGroupSettlementPaymentReference,
  buildInternetBankingPaymentReference,
} from "@/lib/booking-payment-methods";
import { formatBookingReference, storedShortBookingId } from "@/lib/booking-reference";
import { buildBookingAppliedCreditDescription } from "@/lib/member-credit-booking-rows";

// #5407 item 36: the stored short forms of a booking id are written into Xero,
// the credit ledger and members' bank references, and some are matched later.
// These pins are literal on purpose: a change to any expected string here is a
// change to records already written, and must not happen.

// A real cuid (what `@default(cuid())` mints), a fixture id shorter than eight
// characters, ids with upper case and separators (tests and imports use them),
// and the empty string.
const CUID = "cmb7x2k9q0001abcdxyz12345";

describe("storedShortBookingId (#5407 item 36)", () => {
  it.each([
    [CUID, "cmb7x2k9"],
    ["bk-1", "bk-1"],
    ["booking-1", "booking-"],
    ["bkg_abcdef123456", "bkg_abcd"],
    ["ABCdef123456", "ABCdef12"],
    ["", ""],
  ])("keeps the first eight characters of %j exactly as written: %j", (id, expected) => {
    expect(storedShortBookingId(id)).toBe(expected);
  });
});

describe("the Internet Banking references built from it", () => {
  it.each([
    [CUID, "BOOKING-CMB7X2K9"],
    ["bk-1", "BOOKING-BK-1"],
    ["bkg_abcdef123456", "BOOKING-BKG_ABCD"],
    ["ABCdef123456", "BOOKING-ABCDEF12"],
  ])("a booking's reference for %j is %j", (id, expected) => {
    expect(buildInternetBankingPaymentReference(id)).toBe(expected);
  });

  it.each([
    [CUID, "GROUP-CMB7X2K9"],
    ["grp-1", "GROUP-GRP-1"],
  ])("a group settlement's reference for %j is %j", (id, expected) => {
    expect(buildGroupSettlementPaymentReference(id)).toBe(expected);
  });
});

describe("the applied-credit description writer and repair share", () => {
  it("is the stored short id after a fixed phrase", () => {
    expect(buildBookingAppliedCreditDescription(CUID)).toBe("Applied to booking cmb7x2k9");
    expect(buildBookingAppliedCreditDescription("bk-1")).toBe("Applied to booking bk-1");
  });
});

describe("formatBookingReference, the display handle", () => {
  it.each([
    [CUID, "CMB7X2K9"],
    ["bk-1", "BK-1"],
    ["ABCdef123456", "ABCDEF12"],
  ])("upper-cases the stored short id of %j: %j", (id, expected) => {
    expect(formatBookingReference(id)).toBe(expected);
  });
});
