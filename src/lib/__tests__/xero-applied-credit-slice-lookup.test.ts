import { describe, expect, it, vi } from "vitest";

import { findFundingLotsForNote, sliceHeldInXero } from "@/lib/xero-applied-credit-slice-lookup";
import { writtenDownCentsByCreditNote } from "@/lib/xero-credit-note-write-down";

/**
 * The lookups the allocation engine, the legacy repair and the credit-note
 * convergence share (`INV-SSOT`, #4219). Their query shapes are the contract: a
 * funding lot is a positive row for the member and the note that is NOT a
 * convergence row, and a slice is held in Xero only by an ACTIVE completion link.
 */

describe("findFundingLotsForNote", () => {
  it("asks for the member's positive rows stamped with the note, never a convergence row, two at most", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "lot-1", amountCents: 5000 }]);

    await expect(findFundingLotsForNote({ memberCredit: { findMany } } as never, "member-1", "cn-1")).resolves.toEqual([
      { id: "lot-1", amountCents: 5000 },
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { memberId: "member-1", xeroCreditNoteId: "cn-1", amountCents: { gt: 0 }, outsideSpendConvergedAt: null },
      select: { id: true, amountCents: true },
      take: 2,
    });
  });
});

describe("sliceHeldInXero", () => {
  const db = (link: unknown) => ({ xeroObjectLink: { findFirst: vi.fn().mockResolvedValue(link) } });

  it("is true only for an active allocation completion link on that slice", async () => {
    const held = db({ id: "link-1" });
    await expect(sliceHeldInXero(held as never, "slice-1")).resolves.toBe(true);
    expect(held.xeroObjectLink.findFirst).toHaveBeenCalledWith({
      where: {
        localModel: "MemberCreditNoteAllocation",
        localId: "slice-1",
        xeroObjectType: "ALLOCATION",
        role: "APPLIED_CREDIT_ALLOCATION",
        active: true,
      },
      select: { id: true },
    });
    await expect(sliceHeldInXero(db(null) as never, "slice-1")).resolves.toBe(false);
  });
});

describe("writtenDownCentsByCreditNote", () => {
  it("reads only the member's marked negative ADMIN_ADJUSTMENT rows for those notes, as positive cents", async () => {
    const groupBy = vi.fn().mockResolvedValue([{ xeroCreditNoteId: "cn-1", _sum: { amountCents: -2500 } }, { xeroCreditNoteId: null, _sum: { amountCents: -9 } }]);

    const result = await writtenDownCentsByCreditNote({ memberCredit: { groupBy } } as never, "member-1", ["cn-1"]);

    expect(result).toEqual(new Map([["cn-1", 2500]]));
    expect(groupBy).toHaveBeenCalledWith({
      by: ["xeroCreditNoteId"],
      where: {
        memberId: "member-1",
        type: "ADMIN_ADJUSTMENT",
        amountCents: { lt: 0 },
        outsideSpendConvergedAt: { not: null },
        xeroCreditNoteId: { in: ["cn-1"] },
      },
      _sum: { amountCents: true },
    });
  });

  it("reads nothing when no note is asked about", async () => {
    const groupBy = vi.fn();
    await expect(writtenDownCentsByCreditNote({ memberCredit: { groupBy } } as never, "member-1", [])).resolves.toEqual(new Map());
    expect(groupBy).not.toHaveBeenCalled();
  });
});
