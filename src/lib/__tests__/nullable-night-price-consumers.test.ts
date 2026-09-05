import { describe, expect, it } from "vitest";

import { lockedNightPricesForGuest } from "@/lib/booking-modify-plan";
import {
  classifyStoredSoldPriceEvidence,
  storedSoldPriceEvidenceForGuest,
} from "@/lib/stored-sold-price-evidence";
import { requireCalendarDate } from "@/lib/club-time";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";

/**
 * #3170 (epic #2797): every reader of `BookingGuestNight.priceCents` meets a
 * `NULL` now, and the one answer none of them may give is `0`.
 *
 * A stored `0` is a real sold price — a comped night — so a reader that turns an
 * unknown into a zero has not merely lost information, it has made a financial
 * statement nobody made, and the next edit reads that statement back as evidence
 * the member paid nothing. Each case below is one consumer and the decision taken
 * for it.
 */

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const K = (iso: string) => requireCalendarDate(iso);
const RATE = 5000;

describe("#3170 the evidence reader: a null is an absence, never a price", () => {
  it("classifies an unknown night exactly like an absent or unusable one", () => {
    const verdict = classifyStoredSoldPriceEvidence(
      [
        { date: K("2026-08-20"), priceCents: RATE },
        // The row exists and says "not known".
        { date: K("2026-08-21"), priceCents: null },
      ],
      2 * RATE,
    );

    expect(verdict.kind).toBe("unusable");
    if (verdict.kind !== "unusable") return;
    expect(verdict.cause).toBe("PARTIAL_STORED_NIGHT_PRICES");
    // The unknown night is recorded on the evidence as an absence, so an admin
    // sees "we do not know" rather than a number that was never a price.
    expect(verdict.nightPrices).toEqual([
      { date: K("2026-08-20"), priceCents: RATE },
      { date: K("2026-08-21"), priceCents: null },
    ]);
  });

  it("still prices an evenly-split backfilled strand as EXACT", () => {
    // A RECORDED DECISION, and a large share of historical bookings depend on
    // it. Two of the three events that populated this table were themselves even
    // splits (migrations 20260704150000 and 20260810010000), there is no
    // provenance column, and INV-MOD-028 therefore tests RECONCILIATION rather
    // than provenance. Making `priceCents` nullable does not change that test,
    // and this is what proves it: equal integer nights that sum to the stored
    // total are exact, exactly as before, and go nowhere near a person.
    const verdict = storedSoldPriceEvidenceForGuest(
      {
        priceCents: 3 * RATE,
        stayStart: D("2026-08-20"),
        stayEnd: D("2026-08-23"),
        nights: [
          { stayDate: D("2026-08-20"), priceCents: RATE },
          { stayDate: D("2026-08-21"), priceCents: RATE },
          { stayDate: D("2026-08-22"), priceCents: RATE },
        ],
      },
      { checkIn: D("2026-08-20"), checkOut: D("2026-08-23") },
    );

    expect(verdict.kind).toBe("exact");
    if (verdict.kind !== "exact") return;
    expect(verdict.totalCents).toBe(3 * RATE);
  });

  it("sends the same strand to a person the moment ONE night goes unknown", () => {
    // The control for the case above: same booking, same total, one row blanked.
    // Without this pair, "exact" could be what this function always says.
    const verdict = storedSoldPriceEvidenceForGuest(
      {
        priceCents: 3 * RATE,
        stayStart: D("2026-08-20"),
        stayEnd: D("2026-08-23"),
        nights: [
          { stayDate: D("2026-08-20"), priceCents: RATE },
          { stayDate: D("2026-08-21"), priceCents: null },
          { stayDate: D("2026-08-22"), priceCents: RATE },
        ],
      },
      { checkIn: D("2026-08-20"), checkOut: D("2026-08-23") },
    );

    expect(verdict.kind).toBe("unusable");
  });
});

describe("#3170 the lenient lock reader: an unknown night carries no lock", () => {
  it("drops an unknown night rather than locking it at zero", () => {
    const locks = lockedNightPricesForGuest({
      nights: [
        { stayDate: D("2026-08-20"), priceCents: RATE, priceSource: "SOLD" },
        { stayDate: D("2026-08-21"), priceCents: null, priceSource: "UNKNOWN" },
        // A stored zero IS a price — a comped night — and must keep its lock.
        // This is the assertion that stops "null" and "0" being conflated in the
        // direction that costs the member money.
        { stayDate: D("2026-08-22"), priceCents: 0, priceSource: "SOLD" },
      ],
    });

    expect(locks).toEqual([
      { stayDate: D("2026-08-20"), priceCents: RATE, priceSource: "SOLD" },
      { stayDate: D("2026-08-22"), priceCents: 0, priceSource: "SOLD" },
    ]);
  });
});

describe("#3170 the Xero invoice builder: lines still reconcile to the guest total", () => {
  const guest = (nights: Array<{ stayDate: Date; priceCents: number | null }>) => ({
    firstName: "Alice",
    lastName: "Member",
    ageTier: "ADULT",
    isMember: true,
    priceCents: 3 * RATE,
    nights,
  });
  const lineTotal = (lines: Array<{ quantity?: number; unitAmount?: number }>) =>
    Math.round(
      lines.reduce(
        (sum, line) => sum + (line.quantity ?? 0) * (line.unitAmount ?? 0) * 100,
        0,
      ),
    );

  it("bills the whole stay when one night's price is not known", () => {
    // DROPPING THE UNKNOWN NIGHT FROM THE PER-NIGHT RUNS WOULD LOSE MONEY: the
    // runs reconcile to the guest's total only because they partition every
    // night held, so omitting one emits an invoice SHORT by it — a real
    // under-charge on a live Xero document (INV-MONEY-003). So the guest falls
    // to the whole-range branch, which bills the stored total, a real number.
    const lines = buildInvoiceLineItems(
      [
        guest([
          { stayDate: D("2026-08-20"), priceCents: RATE },
          { stayDate: D("2026-08-21"), priceCents: null },
          { stayDate: D("2026-08-22"), priceCents: RATE },
        ]),
      ],
      D("2026-08-20"),
      D("2026-08-23"),
      3,
    );

    expect(lineTotal(lines)).toBe(3 * RATE);
  });

  it("keeps the per-night detail when every night is priced", () => {
    // The control. Without it, the case above would also pass on a builder that
    // had lost per-night invoicing altogether.
    const lines = buildInvoiceLineItems(
      [
        guest([
          { stayDate: D("2026-08-20"), priceCents: RATE },
          { stayDate: D("2026-08-21"), priceCents: 2 * RATE },
          { stayDate: D("2026-08-22"), priceCents: 0 },
        ]),
      ],
      D("2026-08-20"),
      D("2026-08-23"),
      3,
    );

    // Three different nightly amounts, so three runs — the per-night detail is
    // intact, and the stored zero is billed as the real (comped) price it is.
    expect(lines).toHaveLength(3);
    expect(lineTotal(lines)).toBe(3 * RATE);
  });
});
