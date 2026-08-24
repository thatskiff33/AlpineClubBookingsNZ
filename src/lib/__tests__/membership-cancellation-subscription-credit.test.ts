import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  memberSubscriptionFindMany: vi.fn(),
  chargeCoverageFindMany: vi.fn(),
  chargeCoverageFindFirst: vi.fn(),
  xeroSyncOperationFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mocks.memberFindMany },
    memberSubscription: { findMany: mocks.memberSubscriptionFindMany },
    membershipSubscriptionChargeCoverage: {
      findMany: mocks.chargeCoverageFindMany,
      findFirst: mocks.chargeCoverageFindFirst,
    },
    xeroSyncOperation: { findMany: mocks.xeroSyncOperationFindMany },
  },
}));

import type { MembershipCancellationBlocker } from "@/lib/membership-cancellation-blocker-messages";
import {
  buildMembershipCancellationSharedInvoiceNotices,
  buildSharedInvoiceNotice,
  findOtherLiveMembersCoveredBySubscriptionInvoice,
  findSubscriptionInvoiceIdFromCoverage,
  loadLiveMembersCoveredBySubscriptionInvoices,
  loadMembershipCancellationSubscriptionCreditPlansByMemberId,
  type MembershipCancellationSubscriptionCreditPlan,
} from "@/lib/membership-cancellation-subscription-credit";

const NOW_MS = Date.UTC(2026, 6, 31, 3, 0, 0);
// The season the club is in at the frozen instant, WRITTEN OUT rather than derived
// (#2870, correctness review). Computing it by calling the same function the code
// under test calls, with the same arguments, holds for any implementation at all —
// including one that returns a constant. `club-season-year.test.ts` is where the
// derivation itself is proved; here the literal is the oracle.
// `NOW_MS` is 31 July 2026, which in the club's zone is season 2026 on the default
// 31-March year-end.
const SEASON = 2026;

type SubscriptionRow = {
  id?: string;
  memberId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber?: string | null;
  member?: { xeroContactId: string | null };
};

/**
 * `memberSubscription.findMany` is asked two different questions by this module
 * — "whose season subscription would be credited" (season-scoped) and "who is
 * this invoice linked to" (invoice-scoped) — so the fake answers on the shape of
 * the `where`, exactly as the database would.
 */
function respondWithSubscriptions(input: {
  season?: SubscriptionRow[];
  linkedToInvoice?: SubscriptionRow[];
}) {
  mocks.memberSubscriptionFindMany.mockImplementation(
    async (args: { where?: Record<string, unknown> }) => {
      const isSeasonQuery = args?.where?.seasonYear !== undefined;
      return isSeasonQuery
        ? (input.season ?? []).map((row) => ({
            member: { xeroContactId: null },
            ...row,
          }))
        : (input.linkedToInvoice ?? []);
    },
  );
}

/** A `Member` row in the shape the covered-set read selects. */
function memberRow(input: {
  id: string;
  firstName: string;
  lastName: string;
  cancelledAt?: Date | null;
  active?: boolean;
  xeroContactId?: string | null;
}) {
  return {
    id: input.id,
    firstName: input.firstName,
    lastName: input.lastName,
    cancelledAt: input.cancelledAt ?? null,
    active: input.active ?? true,
    xeroContactId: input.xeroContactId ?? null,
  };
}

/** The covered-member shape the module returns. */
function covered(input: {
  memberId: string;
  name: string;
  active?: boolean;
  xeroContactId?: string | null;
}) {
  return {
    memberId: input.memberId,
    name: input.name,
    active: input.active ?? true,
    xeroContactId: input.xeroContactId ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWithSubscriptions({});
  mocks.chargeCoverageFindMany.mockResolvedValue([]);
  mocks.chargeCoverageFindFirst.mockResolvedValue(null);
  mocks.memberFindMany.mockResolvedValue([]);
  // #2400 (review F3): no cancellation credit note has run yet, which is the
  // state every approval-time read sees.
  mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
});

describe("who a subscription invoice still covers", () => {
  it("names every live member the invoice is linked to", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
      memberRow({ id: "member_2", firstName: "Bob", lastName: "Smith" }),
    ]);

    const result = await loadLiveMembersCoveredBySubscriptionInvoices(["inv_1"]);

    expect(result.get("inv_1")).toEqual([
      covered({ memberId: "member_1", name: "Ada Smith" }),
      covered({ memberId: "member_2", name: "Bob Smith" }),
    ]);
  });

  it("counts a member held only by an active charge-coverage claim", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    // The shape that motivates the union: member_2 was already PAID when the
    // family's invoice was raised, so the invoice link was never stamped on
    // their subscription and the coverage claim is the only record of them.
    mocks.chargeCoverageFindMany.mockResolvedValue([
      {
        charge: { xeroInvoiceId: "inv_1" },
        subscription: { memberId: "member_2" },
      },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
      memberRow({ id: "member_2", firstName: "Bob", lastName: "Smith" }),
    ]);

    const result = await loadLiveMembersCoveredBySubscriptionInvoices(["inv_1"]);

    expect(result.get("inv_1")).toEqual([
      covered({ memberId: "member_1", name: "Ada Smith" }),
      covered({ memberId: "member_2", name: "Bob Smith" }),
    ]);
    expect(mocks.chargeCoverageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ releasedAt: null }),
      }),
    );
  });

  it("resolves a coverage claim's member through the subscription, not the merge-stale snapshot column", async () => {
    // #2400 (review F6): MembershipSubscriptionChargeCoverage.memberId is on
    // member-merge's deliberate FK-less snapshot list — a merge never re-points
    // it and then deletes the loser Member it names. Reading it would drop a
    // merged member out of the covered set, and where the coverage claim is the
    // ONLY record of them (the PAID-at-invoice-time shape above) that collapses
    // the covered set to nothing and lets a sibling credit the invoice in full
    // while a covered member remains.
    respondWithSubscriptions({ linkedToInvoice: [] });
    mocks.chargeCoverageFindMany.mockResolvedValue([
      {
        charge: { xeroInvoiceId: "inv_1" },
        // The snapshot column still names the deleted loser; the FK follows the
        // subscription, which the merge re-pointed at the master.
        subscription: { memberId: "master_member" },
      },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "master_member", firstName: "Ada", lastName: "Smith" }),
    ]);

    const result = await loadLiveMembersCoveredBySubscriptionInvoices(["inv_1"]);

    expect(result.get("inv_1")).toEqual([
      covered({ memberId: "master_member", name: "Ada Smith" }),
    ]);
    expect(mocks.chargeCoverageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          subscription: { select: { memberId: true } },
        }),
      }),
    );
    expect(mocks.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["master_member"] } },
      }),
    );
  });

  it("does not let a member who has themselves been cancelled keep the invoice alive", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
      memberRow({
        id: "member_2",
        firstName: "Bob",
        lastName: "Smith",
        cancelledAt: new Date(NOW_MS),
      }),
    ]);

    const result = await loadLiveMembersCoveredBySubscriptionInvoices(["inv_1"]);

    expect(result.get("inv_1")).toEqual([
      covered({ memberId: "member_1", name: "Ada Smith" }),
    ]);
  });

  it("still counts a deactivated member who has not been cancelled, and says they are inactive", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [{ memberId: "member_2", xeroInvoiceId: "inv_1" }],
    });
    // active:false with no cancelledAt is "inactive", not "cancelled" — their
    // season is still billed on this invoice, so the money is still owed. The
    // flag is carried because a deactivated membership cannot be approved for
    // cancellation, so "cancel them first" is not advice anyone can follow.
    mocks.memberFindMany.mockResolvedValue([
      memberRow({
        id: "member_2",
        firstName: "Bob",
        lastName: "Smith",
        active: false,
      }),
    ]);

    const result = await loadLiveMembersCoveredBySubscriptionInvoices(["inv_1"]);

    expect(result.get("inv_1")).toEqual([
      covered({ memberId: "member_2", name: "Bob Smith", active: false }),
    ]);
  });

  it("returns an entry for every invoice asked about, so no key never reads as nobody", async () => {
    const result = await loadLiveMembersCoveredBySubscriptionInvoices([
      "inv_1",
      "inv_2",
    ]);

    expect([...result.keys()].sort()).toEqual(["inv_1", "inv_2"]);
    expect(result.get("inv_1")).toEqual([]);
    expect(result.get("inv_2")).toEqual([]);
  });

  it("reads nothing at all when there are no invoices to ask about", async () => {
    const result = await loadLiveMembersCoveredBySubscriptionInvoices([]);

    expect(result.size).toBe(0);
    expect(mocks.memberSubscriptionFindMany).not.toHaveBeenCalled();
    expect(mocks.chargeCoverageFindMany).not.toHaveBeenCalled();
  });
});

describe("the members other than the leaver", () => {
  it("is empty for a one-member family, so the invoice is credited in full", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
    ]);

    await expect(
      findOtherLiveMembersCoveredBySubscriptionInvoice({
        invoiceId: "inv_1",
        leavingMemberId: "member_1",
      }),
    ).resolves.toEqual([]);
  });

  it("names the family members who are staying", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
        { memberId: "member_3", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
      memberRow({ id: "member_2", firstName: "Bob", lastName: "Smith" }),
      memberRow({ id: "member_3", firstName: "Cy", lastName: "Smith" }),
    ]);

    await expect(
      findOtherLiveMembersCoveredBySubscriptionInvoice({
        invoiceId: "inv_1",
        leavingMemberId: "member_2",
      }),
    ).resolves.toEqual([
      covered({ memberId: "member_1", name: "Ada Smith" }),
      covered({ memberId: "member_3", name: "Cy Smith" }),
    ]);
  });

  it("is empty once the rest of the family has already been cancelled", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({
        id: "member_1",
        firstName: "Ada",
        lastName: "Smith",
        cancelledAt: new Date(NOW_MS),
      }),
      memberRow({ id: "member_2", firstName: "Bob", lastName: "Smith" }),
    ]);

    await expect(
      findOtherLiveMembersCoveredBySubscriptionInvoice({
        invoiceId: "inv_1",
        leavingMemberId: "member_2",
      }),
    ).resolves.toEqual([]);
  });
});

describe("the invoice a coverage claim says a subscription is billed on", () => {
  it("finds it for a member who carries no invoice link of their own", async () => {
    mocks.chargeCoverageFindFirst.mockResolvedValue({
      charge: { xeroInvoiceId: "inv_1" },
    });

    await expect(findSubscriptionInvoiceIdFromCoverage("sub_1")).resolves.toBe(
      "inv_1",
    );
    expect(mocks.chargeCoverageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscriptionId: "sub_1", releasedAt: null },
      }),
    );
  });

  it("is null when no active claim exists", async () => {
    await expect(
      findSubscriptionInvoiceIdFromCoverage("sub_1"),
    ).resolves.toBeNull();
  });
});

describe("the credit plan a cancellation would carry out", () => {
  it("credits in full when the leaver is the last one covered", async () => {
    respondWithSubscriptions({
      season: [
        {
          id: "sub_1",
          memberId: "member_1",
          xeroInvoiceId: "inv_1",
          xeroInvoiceNumber: "INV-0042",
          member: { xeroContactId: "contact_1" },
        },
      ],
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
    ]);

    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toEqual({
      memberId: "member_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      invoiceNumber: "INV-0042",
      xeroUrl: expect.stringContaining("inv_1"),
      memberXeroContactId: "contact_1",
      sharedWith: [],
      creditsInFull: true,
      creditOperationSettled: false,
      excusesUnpaidInvoiceBlocker: true,
    });
    expect(mocks.memberSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          seasonYear: SEASON,
          status: { in: ["UNPAID", "OVERDUE"] },
        }),
      }),
    );
  });

  it("credits nothing when the invoice still covers a member who is staying", async () => {
    respondWithSubscriptions({
      season: [
        {
          id: "sub_1",
          memberId: "member_1",
          xeroInvoiceId: "inv_1",
          xeroInvoiceNumber: "INV-0042",
        },
      ],
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
      memberRow({ id: "member_2", firstName: "Bob", lastName: "Smith" }),
    ]);

    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toMatchObject({
      creditsInFull: false,
      excusesUnpaidInvoiceBlocker: false,
      sharedWith: [covered({ memberId: "member_2", name: "Bob Smith" })],
    });
  });

  it("stops excusing the invoice once the credit note has already run and skipped", async () => {
    // #2400 (review F3). The whole family has now been cancelled, so
    // "would this credit in full?" answers YES again — but this member's credit
    // note already had its single run while siblings were live and skipped. The
    // #2392 archive re-check reads `excusesUnpaidInvoiceBlocker`, so it does not
    // excuse an invoice nobody is going to credit.
    respondWithSubscriptions({
      season: [
        {
          id: "sub_1",
          memberId: "member_1",
          xeroInvoiceId: "inv_1",
          xeroInvoiceNumber: "INV-0042",
        },
      ],
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    mocks.memberFindMany.mockResolvedValue([
      memberRow({ id: "member_1", firstName: "Ada", lastName: "Smith" }),
    ]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([{ localId: "sub_1" }]);

    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toMatchObject({
      creditsInFull: true,
      creditOperationSettled: true,
      excusesUnpaidInvoiceBlocker: false,
    });
    expect(mocks.xeroSyncOperationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "MemberSubscription",
          localId: { in: ["sub_1"] },
          status: { in: ["SUCCEEDED", "PARTIAL"] },
        }),
      }),
    );
  });

  it("has no plan for a member with nothing creditable", async () => {
    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toBeNull();
    expect(plans.has("member_1")).toBe(true);
  });
});

describe("the review queue's shared-invoice notice", () => {
  function plan(
    overrides: Partial<MembershipCancellationSubscriptionCreditPlan> = {},
  ): MembershipCancellationSubscriptionCreditPlan {
    return {
      memberId: "member_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      invoiceNumber: "INV-0042",
      xeroUrl: "https://go.xero.com/inv_1",
      memberXeroContactId: "contact_family",
      sharedWith: [covered({ memberId: "member_2", name: "Bob Smith" })],
      creditsInFull: false,
      creditOperationSettled: false,
      excusesUnpaidInvoiceBlocker: false,
      ...overrides,
    };
  }

  const invoiceBlocker = (invoiceId: string): MembershipCancellationBlocker => ({
    type: "unpaid_invoice",
    invoiceId,
    invoiceNumber: "INV-0042",
    invoiceStatus: "AUTHORISED",
    direction: "receivable",
    amountDueCents: 60000,
    currency: "NZD",
    dueDate: null,
    xeroUrl: null,
    xeroContactUrl: null,
  });

  it("is raised only where nothing will be credited", () => {
    const notices = buildMembershipCancellationSharedInvoiceNotices(
      new Map([
        ["member_1", plan()],
        ["member_9", plan({ memberId: "member_9", sharedWith: [], creditsInFull: true })],
        ["member_8", null],
      ]),
      new Map(),
    );

    expect(notices.get("member_1")).toEqual({
      invoiceId: "inv_1",
      invoiceNumber: "INV-0042",
      xeroUrl: "https://go.xero.com/inv_1",
      sharedWith: [{ memberId: "member_2", name: "Bob Smith" }],
      blocksApproval: false,
      route: "cancel_others_first",
    });
    // Sole covered member: the credit happens, so there is nothing to warn about.
    expect(notices.get("member_9")).toBeNull();
    expect(notices.get("member_8")).toBeNull();
  });

  it("says the approval will be refused when the same invoice is one of the blockers", () => {
    // #2400 (review F2): the family invoice is raised to the charge RECIPIENT's
    // Xero contact, so a parent leaving while the children stay is refused, not
    // merely uncredited.
    const notice = buildSharedInvoiceNotice(plan(), [invoiceBlocker("inv_1")]);

    expect(notice.blocksApproval).toBe(true);
  });

  it("does not claim a refusal for an unrelated unpaid invoice", () => {
    const notice = buildSharedInvoiceNotice(plan(), [
      invoiceBlocker("inv_other"),
    ]);

    expect(notice.blocksApproval).toBe(false);
  });

  it("does not send the reviewer round a loop when the whole family shares one Xero contact", () => {
    // #2400 (review F4): email-inheriting children resolve to their parent's
    // Xero contact, so every one of them meets the identical refusal over the
    // identical invoice. There is no first move.
    const notice = buildSharedInvoiceNotice(
      plan({
        memberXeroContactId: "contact_family",
        sharedWith: [
          covered({
            memberId: "member_2",
            name: "Bob Smith",
            xeroContactId: "contact_family",
          }),
          covered({
            memberId: "member_3",
            name: "Cy Smith",
            xeroContactId: "contact_family",
          }),
        ],
      }),
      [invoiceBlocker("inv_1")],
    );

    expect(notice.route).toBe("shared_xero_contact");
  });

  it("still advises cancelling the others first when one of them is on a different Xero contact", () => {
    const notice = buildSharedInvoiceNotice(
      plan({
        memberXeroContactId: "contact_family",
        sharedWith: [
          covered({
            memberId: "member_2",
            name: "Bob Smith",
            xeroContactId: "contact_family",
          }),
          covered({
            memberId: "member_3",
            name: "Cy Smith",
            xeroContactId: "contact_own",
          }),
        ],
      }),
      [invoiceBlocker("inv_1")],
    );

    expect(notice.route).toBe("cancel_others_first");
  });

  it("does not advise approving members who cannot be approved at all", () => {
    // A deactivated membership is refused by assertParticipantCanBeApproved, so
    // there is nothing to cancel first — they hold the invoice open by design.
    const notice = buildSharedInvoiceNotice(
      plan({
        sharedWith: [
          covered({
            memberId: "member_2",
            name: "Bob Smith",
            active: false,
            xeroContactId: "contact_own",
          }),
        ],
      }),
      [invoiceBlocker("inv_1")],
    );

    expect(notice.route).toBe("remaining_not_cancellable");
  });
});
