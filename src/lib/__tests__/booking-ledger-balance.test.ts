/**
 * The four derived figures, and the reversal that needs no special case
 * (#3580, programme #3527).
 */
import { describe, expect, it } from "vitest";
import {
  bookingLedgerBalance,
  bookingLedgerPriceCents,
  type BookingLedgerLineForBalance,
} from "@/lib/booking-ledger-balance";

const charge = (amountCents: number): BookingLedgerLineForBalance => ({ side: "CHARGE", amountCents });
const settle = (amountCents: number): BookingLedgerLineForBalance => ({ side: "SETTLEMENT", amountCents });
const adjust = (amountCents: number): BookingLedgerLineForBalance => ({ side: "ADJUSTMENT", amountCents });

describe("bookingLedgerBalance", () => {
  it("is all zeroes for a booking with no lines", () => {
    expect(bookingLedgerBalance([])).toEqual({
      chargedCents: 0,
      settledCents: 0,
      adjustedCents: 0,
      owedCents: 0,
    });
  });

  it("owes what is charged until something settles it", () => {
    const lines = [charge(6500), charge(6500)];
    expect(bookingLedgerBalance(lines).owedCents).toBe(13_000);
    expect(bookingLedgerBalance([...lines, settle(13_000)]).owedCents).toBe(0);
  });

  it("reads a club debt as a negative owing", () => {
    // Paid $130, then the stay was reduced to $65: the club owes $65 back.
    const lines = [charge(13_000), settle(13_000), charge(-6500)];
    expect(bookingLedgerBalance(lines).owedCents).toBe(-6500);
  });

  it("counts a refund as negative settlement, not as a charge", () => {
    const balance = bookingLedgerBalance([charge(13_000), settle(13_000), settle(-6500)]);
    expect(balance.settledCents).toBe(6500);
    expect(balance.chargedCents).toBe(13_000);
    expect(balance.owedCents).toBe(6500);
  });

  it("needs no special case for a reversal — the opposite sign cancels in the same sum", () => {
    // The whole design rests on this: there is no "net of reversals" step to
    // forget, because a reversing line is just a line.
    const original = charge(6500);
    const reversal = charge(-6500);
    expect(bookingLedgerBalance([original, reversal]).chargedCents).toBe(0);
    expect(bookingLedgerBalance([original, reversal, charge(7000)]).chargedCents).toBe(7000);
  });

  it("puts an agreed adjustment on the price, not on the settlement", () => {
    const balance = bookingLedgerBalance([charge(13_000), settle(13_000), adjust(2275)]);
    expect(balance.adjustedCents).toBe(2275);
    expect(balance.settledCents).toBe(13_000);
    expect(balance.owedCents).toBe(2275);
    expect(bookingLedgerPriceCents([charge(13_000), adjust(2275)])).toBe(15_275);
  });

  it("is order-independent", () => {
    const lines = [charge(6500), settle(-2000), adjust(500), charge(-1000), settle(9000)];
    const reversed = [...lines].reverse();
    expect(bookingLedgerBalance(lines)).toEqual(bookingLedgerBalance(reversed));
  });
});
