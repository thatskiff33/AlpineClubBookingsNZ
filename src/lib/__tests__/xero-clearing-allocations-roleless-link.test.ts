// #4767: a clearing or edit note's planned allocation that the generic ALLOCATE
// retry linked without the note's role. One predicate decides, for the note's
// PARTIAL retry and the repair tool's PARTIAL check alike (`INV-SSOT`).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findManyXeroObjectLink: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroObjectLink: { findMany: mocks.findManyXeroObjectLink } },
}));
// The repair tool's resolution module reaches the retry module, which this
// pure check does not need.
vi.mock("@/lib/xero-operation-retry", () => ({ getXeroOperationRetryMeta: vi.fn() }));

import {
  CLEARING_TARGET_LINK_ROLES,
  linkAllocatesClearingTarget,
  NOTE_ALLOCATION_ROLE,
  partialClearingNoteIsIncomplete,
  ROLELESS_ALLOCATION_ROLE,
  targetsWithoutAllocation,
  unallocatedClearingTargets,
} from "@/lib/xero-clearing-allocations";
import { noteAllocationLinks } from "@/lib/xero-booking-repair-object-resolution";
import type { XeroObjectLinkRecord } from "@/lib/xero-booking-repair-types";

const TARGET = { invoiceId: "inv_primary", amountCents: 6000 };
const PLAN = [TARGET, { invoiceId: "inv_supp", amountCents: 4000 }];
const PAYLOAD = { invoiceId: "inv_primary", refundAmountCents: 10000, allocations: PLAN };
const link = (role: string, metadata: Record<string, unknown> = {}) => ({
  role,
  metadata: { creditNoteId: "cn_clear", invoiceId: "inv_primary", amountCents: 6000, ...metadata },
});

describe("linkAllocatesClearingTarget (#4767)", () => {
  it("MUTATION: a role-less link for the same note, invoice and amount counts as allocated", () => {
    expect(linkAllocatesClearingTarget(link(ROLELESS_ALLOCATION_ROLE), TARGET, "cn_clear")).toBe(true);
  });

  it.each([
    ["another credit note", { creditNoteId: "cn_other" }],
    ["another invoice", { invoiceId: "inv_supp" }],
    ["another amount", { amountCents: 5999 }],
    ["no recorded amount", { amountCents: undefined }],
    ["a non-numeric amount", { amountCents: "six thousand" }],
  ])("MUTATION: a role-less link for %s does not", (_label, metadata) => {
    expect(linkAllocatesClearingTarget(link(ROLELESS_ALLOCATION_ROLE, metadata), TARGET, "cn_clear")).toBe(false);
  });

  // The note's own role keeps the #4259 rule: note and invoice. Only the note's
  // own writers give a link that role, for a planned target.
  it("MUTATION: a link with the note's role counts for the same note and invoice, whatever amount it records", () => {
    expect(linkAllocatesClearingTarget(link(NOTE_ALLOCATION_ROLE, { amountCents: undefined }), TARGET, "cn_clear")).toBe(true);
    expect(linkAllocatesClearingTarget(link(NOTE_ALLOCATION_ROLE, { creditNoteId: "cn_other" }), TARGET, "cn_clear")).toBe(false);
    expect(linkAllocatesClearingTarget(link(NOTE_ALLOCATION_ROLE, { invoiceId: "inv_supp" }), TARGET, "cn_clear")).toBe(false);
  });

  it.each(["APPLIED_CREDIT_ALLOCATION", "REFUND_CREDIT_NOTE_ALLOCATION", ""])(
    "MUTATION: a link with role %j naming the same note, invoice and amount does not",
    (role) => {
      expect(linkAllocatesClearingTarget(link(role), TARGET, "cn_clear")).toBe(false);
    }
  );
});

describe("the retry and the repair tool read the same links (#4767, INV-SSOT)", () => {
  it("lists exactly the roles the predicate can accept", () => {
    expect([...CLEARING_TARGET_LINK_ROLES].sort()).toEqual([ROLELESS_ALLOCATION_ROLE, NOTE_ALLOCATION_ROLE].sort());
  });

  it("MUTATION: the retry queries the note's role and the role-less one, and skips the role-less-linked target", async () => {
    mocks.findManyXeroObjectLink.mockResolvedValue([link(ROLELESS_ALLOCATION_ROLE)]);

    await expect(
      unallocatedClearingTargets({ creditNoteId: "cn_clear", targets: PLAN, localModel: "Booking", localId: "booking_1" })
    ).resolves.toEqual([{ invoiceId: "inv_supp", amountCents: 4000 }]);
    expect(mocks.findManyXeroObjectLink).toHaveBeenCalledWith({
      where: {
        localModel: "Booking",
        localId: "booking_1",
        xeroObjectType: "ALLOCATION",
        role: { in: [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE] },
        active: true,
      },
      select: { role: true, metadata: true },
    });
  });

  const record = (role: string, xeroObjectType = "ALLOCATION", metadata: Record<string, unknown> = {}) =>
    ({ ...link(role, metadata), xeroObjectType }) as unknown as XeroObjectLinkRecord;

  it("MUTATION: the repair tool keeps the role-less allocation links the retry reads, and no other", () => {
    const kept = record(ROLELESS_ALLOCATION_ROLE);
    const own = record(NOTE_ALLOCATION_ROLE);
    expect(
      noteAllocationLinks([kept, own, record("APPLIED_CREDIT_ALLOCATION"), record(ROLELESS_ALLOCATION_ROLE, "PAYMENT")])
    ).toEqual([kept, own]);
  });

  it.each([
    ["a role-less link for the primary", [link(ROLELESS_ALLOCATION_ROLE)], true],
    ["role-less links for both", [link(ROLELESS_ALLOCATION_ROLE), link(ROLELESS_ALLOCATION_ROLE, { invoiceId: "inv_supp", amountCents: 4000 })], false],
    ["a role-less link at another amount and an own one", [link(ROLELESS_ALLOCATION_ROLE, { amountCents: 1 }), link(NOTE_ALLOCATION_ROLE, { invoiceId: "inv_supp" })], true],
    ["an own link and a role-less one", [link(NOTE_ALLOCATION_ROLE), link(ROLELESS_ALLOCATION_ROLE, { invoiceId: "inv_supp", amountCents: 4000 })], false],
  ])("MUTATION: the PARTIAL check agrees with the retry with %s", (_label, links, incomplete) => {
    expect(partialClearingNoteIsIncomplete(PAYLOAD, "cn_clear", links)).toBe(incomplete);
    expect(targetsWithoutAllocation(PLAN, "cn_clear", links).length > 0).toBe(incomplete);
  });
});

beforeEach(() => {
  mocks.findManyXeroObjectLink.mockReset();
});
