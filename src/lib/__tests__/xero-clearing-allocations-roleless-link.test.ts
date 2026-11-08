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
  CLEARING_ALLOCATION_LINK_WHERE,
  CLEARING_TARGET_LINK_ROLES,
  distinctClearingAllocations,
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

// #4786: the money readers count a clearing note's allocations through this one
// reader, built on the predicate above.
describe("distinctClearingAllocations (#4786)", () => {
  const T0 = "2026-06-01T00:00:00.000Z";
  const at = (l: ReturnType<typeof link>, iso = T0) => ({ ...l, updatedAt: new Date(iso) });
  type Link = ReturnType<typeof at>;
  const allocations = (links: Link[], options?: { creditNoteId?: string; requireAmount?: boolean }) =>
    distinctClearingAllocations(links, options).map(({ creditNoteId: note, invoiceId, amountCents }) => [note, invoiceId, amountCents]);

  it("reads an own-role link and a role-less one", () => {
    expect(allocations([at(link(NOTE_ALLOCATION_ROLE))])).toEqual([["cn_clear", "inv_primary", 6000]]);
    expect(allocations([at(link(ROLELESS_ALLOCATION_ROLE))])).toEqual([["cn_clear", "inv_primary", 6000]]);
  });

  it("MUTATION: an own-role and a role-less link for the same note, invoice and amount count once", () => {
    expect(allocations([at(link(NOTE_ALLOCATION_ROLE)), at(link(ROLELESS_ALLOCATION_ROLE))])).toEqual([["cn_clear", "inv_primary", 6000]]);
  });

  // The inbound mirror writes one own-role link per note and invoice with the
  // note's applications SUMMED, beside the builder's per-allocation link and a
  // role-less piece; adding any of them to it counts an allocation twice.
  it("MUTATION: a role-less piece and the mirror's summed link count the summed figure once", () => {
    expect(
      allocations([
        at(link(ROLELESS_ALLOCATION_ROLE, { amountCents: 4000 }), "2026-06-01T00:00:00.000Z"),
        at(link(NOTE_ALLOCATION_ROLE, { amountCents: 10_000 }), "2026-06-03T00:00:00.000Z"),
      ]),
    ).toEqual([["cn_clear", "inv_primary", 10_000]]);
  });

  it("MUTATION: the builder's per-allocation link and the mirror's summed link count once, the newest", () => {
    expect(
      allocations([
        at(link(NOTE_ALLOCATION_ROLE, { amountCents: 10_000 }), "2026-06-03T00:00:00.000Z"),
        at(link(NOTE_ALLOCATION_ROLE, { amountCents: 6000 }), "2026-06-01T00:00:00.000Z"),
      ]),
    ).toEqual([["cn_clear", "inv_primary", 10_000]]);
  });

  // A generic ALLOCATE retry links role-less and can replay an older single
  // allocation after the mirror recorded the note's sum for that invoice.
  it("MUTATION: a role-less link written after the mirror's own-role sum never replaces it", () => {
    expect(
      allocations([
        at(link(NOTE_ALLOCATION_ROLE, { amountCents: 10_000 }), "2026-06-03T00:00:00.000Z"),
        at(link(ROLELESS_ALLOCATION_ROLE, { amountCents: 6000 }), "2026-06-05T00:00:00.000Z"),
      ]),
    ).toEqual([["cn_clear", "inv_primary", 10_000]]);
  });

  it("MUTATION: of role-less links alone, the newest counts", () => {
    expect(
      allocations([
        at(link(ROLELESS_ALLOCATION_ROLE, { amountCents: 6000 }), "2026-06-05T00:00:00.000Z"),
        at(link(ROLELESS_ALLOCATION_ROLE, { amountCents: 4000 }), "2026-06-01T00:00:00.000Z"),
      ]),
    ).toEqual([["cn_clear", "inv_primary", 6000]]);
  });

  it("another invoice or note is another application", () => {
    expect(
      allocations([
        at(link(NOTE_ALLOCATION_ROLE)),
        at(link(ROLELESS_ALLOCATION_ROLE, { amountCents: 4000 })),
        at(link(ROLELESS_ALLOCATION_ROLE, { invoiceId: "inv_supp" })),
        at(link(ROLELESS_ALLOCATION_ROLE, { creditNoteId: "cn_other" })),
      ]),
    ).toEqual([
      ["cn_clear", "inv_primary", 6000],
      ["cn_clear", "inv_supp", 6000],
      ["cn_other", "inv_primary", 6000],
    ]);
  });

  it("MUTATION: a role-less link with no amount, or a link with any other role, is no allocation", () => {
    expect(allocations([at(link(ROLELESS_ALLOCATION_ROLE, { amountCents: undefined }))])).toEqual([]);
    expect(allocations([at(link("APPLIED_CREDIT_ALLOCATION")), at(link(""))])).toEqual([]);
  });

  it("keeps an own-role link with no amount, amount unknown, unless an amount is required; a link naming no note or invoice is none", () => {
    expect(allocations([at(link(NOTE_ALLOCATION_ROLE, { amountCents: undefined }))])).toEqual([["cn_clear", "inv_primary", null]]);
    expect(allocations([at(link(NOTE_ALLOCATION_ROLE, { amountCents: undefined }))], { requireAmount: true })).toEqual([]);
    expect(allocations([at(link(NOTE_ALLOCATION_ROLE, { creditNoteId: undefined })), at(link(NOTE_ALLOCATION_ROLE, { invoiceId: undefined }))])).toEqual([]);
  });

  it.each([
    ["no amount", undefined],
    ["a zero amount", 0],
    ["a negative amount", -500],
  ])("MUTATION: with an amount required, a newer own-role link with %s never hides an older one that has one", (_label, amountCents) => {
    const older = at(link(NOTE_ALLOCATION_ROLE, { amountCents: 6000 }), "2026-06-01T00:00:00.000Z");
    const newer = at(link(NOTE_ALLOCATION_ROLE, { amountCents }), "2026-06-03T00:00:00.000Z");
    expect(allocations([older, newer], { requireAmount: true })).toEqual([["cn_clear", "inv_primary", 6000]]);
  });

  it("MUTATION: with a note, only that note's allocations", () => {
    expect(allocations([at(link(NOTE_ALLOCATION_ROLE)), at(link(NOTE_ALLOCATION_ROLE, { creditNoteId: "cn_other" }))], { creditNoteId: "cn_other" })).toEqual([
      ["cn_other", "inv_primary", 6000],
    ]);
  });
});

describe("CLEARING_ALLOCATION_LINK_WHERE (#4786)", () => {
  it("MUTATION: reads the note's own role anywhere, and the role-less one never on a payment", () => {
    expect(CLEARING_ALLOCATION_LINK_WHERE).toEqual({
      OR: [{ role: NOTE_ALLOCATION_ROLE }, { role: ROLELESS_ALLOCATION_ROLE, localModel: { not: "Payment" } }],
    });
  });
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
