/**
 * The one home for a ledger posting key (#3595): the formats are pinned here,
 * literally, because a key that drifts by one character no longer collides
 * with the key it was meant to — and that is a double post, silently.
 */
import { describe, expect, it } from "vitest";
import {
  confirmationNightKey,
  confirmationPromotionKey,
  reversalKey,
} from "@/lib/booking-ledger-posting-keys";

const NIGHT = new Date("2026-08-01T00:00:00.000Z");

describe("booking-ledger posting keys", () => {
  it("pins every format literally", () => {
    expect(confirmationNightKey("b1", "g1", NIGHT)).toBe("confirmation:b1:night:g1:2026-08-01");
    expect(confirmationPromotionKey("b1")).toBe("confirmation:b1:promotion");
    expect(reversalKey("line-9")).toBe("reversal:line-9");
  });

  it("reads a stored night as the calendar day it encodes, whatever the host zone", () => {
    // A @db.Date is UTC midnight; the key must be the day it encodes, so the
    // same night keys the same at both settles (INV-DATE-019).
    expect(confirmationNightKey("b1", "g1", new Date("2026-12-31T00:00:00.000Z"))).toBe(
      "confirmation:b1:night:g1:2026-12-31",
    );
  });

  it("keys a reversal by the reversed line's ID, which every line has", () => {
    // A line posted before #3595 has no key, so a reversal cannot be keyed by
    // one; every line has an id. Two reversals of one line therefore always
    // share a key, and the second is a skipped replay rather than a second,
    // different posting the unique reversesLineId could silently absorb.
    expect(reversalKey("x")).toBe(reversalKey("x"));
    expect(reversalKey("x")).not.toBe(reversalKey("y"));
  });
});
