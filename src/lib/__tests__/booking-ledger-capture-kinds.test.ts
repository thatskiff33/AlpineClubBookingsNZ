import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CAPTURE_CASH_ACCOUNTS, CAPTURE_KIND_RECEIPTS, CAPTURE_KINDS } from "@/lib/booking-ledger-capture-kinds";
import { CAPTURE_KINDS as CENSUS_CAPTURE_KINDS } from "@/lib/booking-ledger-projection-census-classes";
import { planSettlementLines } from "@/lib/booking-ledger-settlement-posting";

/**
 * #4516 review (`INV-SSOT`): the capture-kind map's keys are exactly the kinds
 * the settlement planner posts for captured money, from every payment source,
 * settled manually or not. A kind the planner posts and the map lacks would
 * never post a member-money receipt (R06/R07/R08); one the map names and the
 * planner never posts would be a receipt the census can never find.
 */
describe("the capture kinds are one list", () => {
  it("names exactly the kinds the settlement planner posts for a capture", () => {
    const posted = new Set<string>();
    for (const source of Object.values(PaymentSource)) {
      for (const manuallySettled of [false, true]) {
        const plan = planSettlementLines({
          bookingId: "booking-4516", lodgeId: "lodge-4516", manuallySettled, manualActorMemberId: manuallySettled ? "officer-4516" : null,
          transactions: [{ id: `txn-${source}-${manuallySettled}`, source, status: PaymentStatus.SUCCEEDED, amountCents: 1_000 }],
          refunds: [], postedLines: [],
        });
        for (const posting of plan.postings) posted.add(posting.kind);
      }
    }
    expect([...posted].sort()).toEqual([...CAPTURE_KINDS].sort());
    expect(Object.keys(CAPTURE_KIND_RECEIPTS).sort()).toEqual([...CAPTURE_KINDS].sort());
  });

  it("is the list the booking-ledger census sums, and gives each kind its own cash account", () => {
    expect(CENSUS_CAPTURE_KINDS).toBe(CAPTURE_KINDS);
    expect(new Set(CAPTURE_CASH_ACCOUNTS).size).toBe(CAPTURE_KINDS.length);
  });
});
