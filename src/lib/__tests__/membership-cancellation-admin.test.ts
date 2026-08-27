import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    member: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      // #2255: the approval reads who it is about to detach — dependants and
      // email inheritors — before the link sweep nulls those columns, so the
      // admin can be told. Defaults to "nobody", which most fixtures want.
      findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
      count: vi.fn(),
    },
    familyGroupMember: {
      deleteMany: vi.fn(),
    },
    membershipCancellationRequestParticipant: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
    membershipCancellationRequest: {
      update: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(async (callback: (txArg: typeof tx) => unknown) =>
      callback(tx),
    ),
    participantFindUnique: vi.fn(),
    requestFindUnique: vi.fn(),
    requestFindMany: vi.fn(),
    requestCount: vi.fn(),
    bookingFindMany: vi.fn(),
    bookingGuestFindMany: vi.fn(),
    createAuditLog: vi.fn(),
    sendApprovedEmail: vi.fn(),
    sendRejectedEmail: vi.fn(),
    loadSettings: vi.fn(),
    queueCancellationXeroOperations: vi.fn(),
    // #2392: the unpaid-Xero-invoice half of the blocker set. Stubbed to
    // "nothing owing" by default; the tests that care drive it directly.
    loadInvoiceBlockers: vi.fn(),
    loadCreditPlans: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    booking: {
      findMany: mocks.bookingFindMany,
    },
    bookingGuest: {
      findMany: mocks.bookingGuestFindMany,
    },
    membershipCancellationRequest: {
      findUnique: mocks.requestFindUnique,
      findMany: mocks.requestFindMany,
      count: mocks.requestCount,
    },
    membershipCancellationRequestParticipant: {
      findUnique: mocks.participantFindUnique,
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/email", () => ({
  sendMembershipCancellationApprovedEmail: mocks.sendApprovedEmail,
  sendMembershipCancellationRejectedEmail: mocks.sendRejectedEmail,
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  loadMembershipCancellationSettings: mocks.loadSettings,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  queueApprovedMembershipCancellationXeroOperations:
    mocks.queueCancellationXeroOperations,
}));

vi.mock("@/lib/membership-cancellation-invoice-blockers", () => ({
  loadMembershipCancellationInvoiceBlockersByMemberId: mocks.loadInvoiceBlockers,
}));

// #2400: what this cancellation will (or will not) credit. Only the DATABASE
// read is stubbed — the notice builders stay real, so these tests exercise the
// same wording and the same blocks-approval decision the review queue renders.
vi.mock("@/lib/membership-cancellation-subscription-credit", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/membership-cancellation-subscription-credit")
  >()),
  loadMembershipCancellationSubscriptionCreditPlansByMemberId:
    mocks.loadCreditPlans,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// #2576 §8: the lifecycle change records the coverage re-evaluation it owes.
const hostingMocks = vi.hoisted(() => ({
  fanout: vi.fn(async (...args: unknown[]) => {
    void args;
    return 1;
  }),
  drain: vi.fn(async (...args: unknown[]) => {
    void args;
  }),
}));

// #2576 §8. "Membership becoming inactive, lapsed, cancelled or archived" is the FIRST
// change class the owner's decision names, and only the evaluator half of it was
// automatic — an archived or cancelled member correctly stops qualifying as an adult
// host, while nothing told the club to go and look at the bookings that had been relying
// on them. The lifecycle paths now record that obligation inside their own transaction,
// which means they read the bookings this person ATTENDS through the caller's `tx` — and
// this suite drives that transaction with a fake carrying only the lifecycle delegates.
//
// Mocked at the module boundary so the assertion here can be about the thing that
// belongs here: that the change RECORDS the re-evaluation and is never refused by it.
// What the re-evaluation then concludes is the hosting suites' subject.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: (...args: unknown[]) =>
    hostingMocks.fanout(...args),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: (...args: unknown[]) =>
    hostingMocks.drain(...args),
}));


import {
  getAdminMembershipCancellationRequests,
  MembershipCancellationAdminError,
  reviewMembershipCancellationParticipant,
} from "@/lib/membership-cancellation-admin";
import { isMembershipCancellationParticipantAwaitingApproval } from "@/lib/membership-cancellation-approval-readiness";
import {
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
} from "@/lib/admin-account-guards";
import type { MembershipCancellationSubscriptionCreditPlan } from "@/lib/membership-cancellation-subscription-credit";

const ADMIN_ACCESS_ROLES = [
  { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
];

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.org",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    cancelledAt: null,
    cancelledReason: null,
    cancelledViaRequestId: null,
    ...overrides,
  };
}

/**
 * #2400: a credit plan whose invoice still covers a member who is staying, so
 * the cancellation credits nothing against it.
 */
function sharedCreditPlan(
  overrides: Partial<MembershipCancellationSubscriptionCreditPlan> = {},
): MembershipCancellationSubscriptionCreditPlan {
  return {
    memberId: "member-1",
    subscriptionId: "sub-1",
    invoiceId: "inv-1",
    invoiceNumber: "INV-0042",
    xeroUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1",
    memberXeroContactId: "contact-1",
    sharedWith: [
      {
        memberId: "member-2",
        name: "Bob Smith",
        active: true,
        xeroContactId: "contact-2",
      },
    ],
    creditsInFull: false,
    creditOperationSettled: false,
    excusesUnpaidInvoiceBlocker: false,
    ...overrides,
  };
}

/** The same invoice, seen from the unpaid-invoice blocker's side. */
function unpaidInvoiceBlocker(invoiceId = "inv-1") {
  return {
    type: "unpaid_invoice" as const,
    invoiceId,
    invoiceNumber: "INV-0042",
    invoiceStatus: "AUTHORISED",
    direction: "receivable" as const,
    amountDueCents: 60000,
    currency: "NZD",
    dueDate: null,
    xeroUrl: null,
    xeroContactUrl: null,
  };
}

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant-1",
    requestId: "request-1",
    memberId: "member-1",
    status: "REQUESTED",
    reason: null,
    adminNote: null,
    confirmationTokenHash: null,
    confirmationTokenExpiresAt: null,
    confirmedAt: new Date("2026-05-24T00:00:00.000Z"),
    declinedAt: null,
    cancelledAt: null,
    reviewedByMemberId: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    member: member(),
    request: {
      id: "request-1",
      status: "REQUESTED",
      reason: "Moving away",
      requestedByMemberId: "requester-1",
    },
    ...overrides,
  };
}

function adminRequest(participantOverrides: Record<string, unknown> = {}) {
  const baseParticipant = {
    ...participant(participantOverrides),
    reviewedBy: null,
    member: member(participantOverrides.member as Record<string, unknown> | undefined),
  };

  return {
    id: "request-1",
    requestedByMemberId: "requester-1",
    status: "REQUESTED",
    reason: "Moving away",
    adminNote: null,
    submittedAt: new Date("2026-05-24T00:00:00.000Z"),
    reviewedByMemberId: null,
    reviewedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    requestedBy: member({
      id: "requester-1",
      firstName: "Rae",
      lastName: "Requester",
      email: "rae@example.org",
    }),
    reviewedBy: null,
    participants: [baseParticipant],
  };
}

describe("membership cancellation admin review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.participantFindUnique.mockResolvedValue(participant());
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingGuestFindMany.mockResolvedValue([]);
    mocks.loadInvoiceBlockers.mockImplementation(
      async (memberIds: readonly string[]) =>
        new Map(memberIds.map((memberId) => [memberId, []])),
    );
    mocks.loadCreditPlans.mockImplementation(
      async (memberIds: readonly string[]) =>
        new Map(memberIds.map((memberId) => [memberId, null])),
    );
    // Admin-account guard defaults (#1604/#1622): a plain, non-privileged
    // target with no admins to strand, so neither guard trips.
    mocks.tx.member.findUnique.mockResolvedValue({
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [],
    });
    mocks.tx.member.count.mockResolvedValue(0);
    // #2255: re-seeded per test because `vi.clearAllMocks()` clears calls but
    // NOT implementations, so a fixture that stubs the detached-links reads
    // would otherwise leak into every test that follows it.
    mocks.tx.member.findMany.mockImplementation(async () => []);
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "CANCELLED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(
      adminRequest({ status: "CANCELLED", cancelledAt: new Date("2026-05-24T01:00:00.000Z") }),
    );
    mocks.loadSettings.mockResolvedValue({
      rejoinProcessText: "Contact the club secretary before rejoining.",
    });
    mocks.sendApprovedEmail.mockResolvedValue(undefined);
    mocks.sendRejectedEmail.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.queueCancellationXeroOperations.mockResolvedValue({
      seasonYear: 2026,
      results: [],
    });
  });

  it("approves a confirmed participant and locally cancels the membership", async () => {
    const result = await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
      adminNote: "Approved by committee",
      ipAddress: "203.0.113.1",
    });

    // #2576 §8. A cancelled membership stops qualifying as an adult host, so a confirmed
    // booking that was relying on that person is now uncovered - and "membership becoming
    // inactive, lapsed, cancelled or archived" is the FIRST change class the owner's
    // decision names among those that cannot be blocked but MUST record the
    // re-evaluation. Before this the evaluator half worked and nothing told the club to
    // look: no incident, no owner email, no officer-queue entry.
    //
    // Recorded for the CANCELLED PARTICIPANT, inside the approval's own transaction, and
    // it never refuses the cancellation. Drained unfiltered after the commit, because one
    // person can attend bookings owned by several accounts at several lodges.
    expect(hostingMocks.fanout).toHaveBeenCalledTimes(1);
    expect(hostingMocks.fanout.mock.calls[0]?.[2]).toBeInstanceOf(Date);
    expect(hostingMocks.fanout.mock.calls[0]?.[3] as object).toMatchObject({
      cause: "SYSTEM_CHANGE",
      actorMemberId: "admin-1",
    });
    expect(hostingMocks.drain).toHaveBeenCalledTimes(1);

    expect(result.request.participants[0].status).toBe("CANCELLED");
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: expect.objectContaining({
        active: false,
        canLogin: false,
        cancelledAt: expect.any(Date),
        cancelledReason: "Moving away",
        cancelledViaRequestId: "request-1",
        familyGroupId: null,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        // #2716: the cancelled member's own recorded CHOICE is cleared beside
        // their pointer and their parent links. They are leaving the club, so
        // there is no decision left to honour — and a choice left standing would
        // list them forever on the "waiting on a parent's address" surface.
        inheritEmailChoiceId: null,
      }),
    });
    expect(mocks.tx.familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mocks.tx.membershipCancellationRequestParticipant.update).toHaveBeenCalledWith({
      where: { id: "participant-1" },
      data: expect.objectContaining({
        status: "CANCELLED",
        adminNote: "Approved by committee",
        reviewedByMemberId: "admin-1",
        confirmationTokenHash: null,
      }),
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.participant_cancelled",
        outcome: "success",
        metadata: expect.objectContaining({ xeroCancellationDeferred: true }),
      }),
      mocks.tx,
    );
    expect(mocks.queueCancellationXeroOperations).toHaveBeenCalledWith({
      memberId: "member-1",
      requestId: "request-1",
      participantId: "participant-1",
      createdByMemberId: "admin-1",
    });
    expect(mocks.sendApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.org",
        participantName: "Alice Smith",
        rejoinProcessText: "Contact the club secretary before rejoining.",
      }),
    );
  });

  /**
   * #2255 (D9). Approving a cancellation clears ONE level of family links: the
   * member's own parent links, and every link pointing at them. With chains of
   * up to four generations the member being cancelled is often a MIDDLE
   * generation, so that sweep silently detaches their own dependants from the
   * family and leaves anyone inheriting their address with no mailbox.
   *
   * The decided outcome is "detached and DECLARED": grandchildren are NOT
   * re-parented onto the grandparent, because who is responsible for a member
   * is a real-world fact and promoting it because someone left the club would
   * record a relationship nobody asserted — but the admin is told exactly who
   * was affected, in the response and in the audit trail.
   */
  describe("orphaned family links (#2255)", () => {
    function detaching(
      dependants: Array<{ id: string; firstName: string; lastName: string; email: string }>,
      inheritors: Array<{ id: string; firstName: string; lastName: string; email: string }> = [],
    ) {
      // #2716: BOTH reads are `OR` queries now — the parent read has always
      // been one (`parentMemberId` / `secondaryParentId`), and the inheritor
      // read became one when it started matching the CHOICE column as well as
      // the pointer. A top-level `where.inheritEmailFromId` therefore no longer
      // exists on either, and every read was being answered with the dependant
      // fixture. Route on which COLUMNS the clauses name, which is the thing the
      // two reads have always genuinely differed by.
      mocks.tx.member.findMany.mockImplementation(async ({ where }: any) => {
        const clauses: Array<Record<string, unknown>> = where?.OR ?? [where ?? {}];
        const readsInheritance = clauses.some(
          (clause) =>
            "inheritEmailFromId" in clause || "inheritEmailChoiceId" in clause,
        );
        return readsInheritance ? inheritors : dependants;
      });
    }

    it("names the dependants whose parent link was cleared", async () => {
      detaching([
        { id: "grandchild-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" },
        { id: "grandchild-2", firstName: "Ben", lastName: "Smith", email: "ben@example.org" },
      ]);

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(result.orphanedLinks.dependants).toEqual([
        { id: "grandchild-1", name: "Ana Smith", email: "ana@example.org" },
        { id: "grandchild-2", name: "Ben Smith", email: "ben@example.org" },
      ]);
    });

    it("names the members left without an inherited mailbox", async () => {
      detaching(
        [],
        [{ id: "kid-1", firstName: "Cai", lastName: "Smith", email: "cai@example.org" }],
      );

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(result.orphanedLinks.emailInheritors).toEqual([
        { id: "kid-1", name: "Cai Smith", email: "cai@example.org" },
      ]);
      // #2716: and the read must ASK about the CHOICE as well as the pointer. A
      // member whose chosen source is temporarily unreachable holds the choice
      // beside a NULL pointer; they were already waiting on that mailbox, and
      // cancelling the member is what makes the wait permanent — so a
      // pointer-only read would leave exactly them out of the declaration.
      expect(mocks.tx.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { inheritEmailFromId: "member-1" },
              { inheritEmailChoiceId: "member-1" },
            ],
          },
        }),
      );
    });

    it("does NOT re-parent the detached dependants onto a grandparent", async () => {
      detaching([
        { id: "grandchild-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" },
      ]);

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      // Every write to the dependants' parent columns clears them; none sets a
      // new parent. Promoting a grandparent into the parent slot would change
      // who is legally responsible for a child, silently, as a side effect of
      // someone else's cancellation.
      const parentColumnWrites = mocks.tx.member.updateMany.mock.calls
        .map((call: unknown[]) => (call[0] as { data?: Record<string, unknown> })?.data ?? {})
        .filter(
          (data: any) =>
            "parentMemberId" in data || "secondaryParentId" in data,
        );
      expect(parentColumnWrites.length).toBeGreaterThan(0);
      for (const data of parentColumnWrites) {
        expect(Object.values(data)).toEqual([null]);
      }
    });

    it("records the detached members in the audit trail as well as the response", async () => {
      detaching(
        [{ id: "grandchild-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" }],
        [{ id: "kid-1", firstName: "Cai", lastName: "Smith", email: "cai@example.org" }],
      );

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "membership_cancellation.participant_cancelled",
          metadata: expect.objectContaining({
            detachedDependantIds: ["grandchild-1"],
            detachedEmailInheritorIds: ["kid-1"],
          }),
        }),
        mocks.tx,
      );
    });

    it("reports empty lists rather than omitting them when nothing was linked", async () => {
      // A caller must not have to distinguish "no key" from "nothing detached".
      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(result.orphanedLinks).toEqual({
        dependants: [],
        emailInheritors: [],
      });
    });
  });

  it("blocks approval when future bookings remain", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        memberId: "member-1",
        checkIn: new Date("2099-01-01T00:00:00.000Z"),
        checkOut: new Date("2099-01-03T00:00:00.000Z"),
        status: "PAID",
      },
    ]);

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        metadata: expect.objectContaining({
          blockers: [
            expect.objectContaining({
              type: "owned_booking",
              bookingId: "booking-1",
            }),
          ],
        }),
      }),
    );
  });

  it("blocks approval when future guest appearances remain", async () => {
    mocks.bookingGuestFindMany.mockResolvedValue([
      {
        id: "guest-1",
        memberId: "member-1",
        stayStart: new Date("2099-02-01T00:00:00.000Z"),
        stayEnd: new Date("2099-02-02T00:00:00.000Z"),
        booking: {
          id: "booking-2",
          checkIn: new Date("2099-02-01T00:00:00.000Z"),
          checkOut: new Date("2099-02-02T00:00:00.000Z"),
          status: "CONFIRMED",
        },
      },
    ]);

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        metadata: expect.objectContaining({
          blockers: [
            expect.objectContaining({
              type: "guest_appearance",
              bookingId: "booking-2",
              guestAppearanceId: "guest-1",
            }),
          ],
        }),
      }),
    );
  });

  // #2392: approving queues a Xero contact archive, so a contact the accounts
  // still need must not be archived out from under them.
  it("blocks approval while the member's Xero contact has an unpaid invoice, and names it", async () => {
    mocks.loadInvoiceBlockers.mockResolvedValue(
      new Map([
        [
          "member-1",
          [
            {
              type: "unpaid_invoice",
              invoiceId: "inv-1",
              invoiceNumber: "INV-0042",
              invoiceStatus: "AUTHORISED",
              direction: "receivable",
              amountDueCents: 12050,
              currency: "NZD",
              dueDate: "2026-06-30",
              xeroUrl: "https://go.xero.com/x",
            },
          ],
        ],
      ]),
    );

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      // The refusal must be actionable: which invoice, how much, and what to do.
      message: expect.stringContaining("INV-0042 (NZD 120.50)"),
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.queueCancellationXeroOperations).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        details: expect.stringContaining(
          "paid, credited with an allocated credit note, or voided in Xero",
        ),
        metadata: expect.objectContaining({
          blockerTypes: ["unpaid_invoice"],
          blockers: [expect.objectContaining({ invoiceNumber: "INV-0042" })],
        }),
      }),
    );
  });

  it("blocks approval when Xero could not be checked at all", async () => {
    mocks.loadInvoiceBlockers.mockResolvedValue(
      new Map([
        ["member-1", [{ type: "invoice_check_unavailable", reason: "disconnected" }]],
      ]),
    );

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Xero is not connected"),
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("decides the approval on a live invoice answer, never the review queue's memo", async () => {
    await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
    });

    expect(mocks.loadInvoiceBlockers).toHaveBeenCalledWith(
      ["member-1"],
      expect.objectContaining({ fresh: true }),
    );
  });

  // The old assertion here was near-vacuous: the reject path DOES reach the
  // invoice loader, through the post-review reload that rebuilds the queue. What
  // matters is that rejecting never takes a LIVE Xero answer, and — more to the
  // point — that money owing cannot stop a rejection. Nothing is archived by a
  // rejection, so there is nothing to protect (#2392 review, L12).
  it("rejects a participant whose Xero contact owes money, without a live Xero check", async () => {
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "REJECTED" },
    ]);
    // The reload rebuilds the queue for whoever is still awaiting review, which
    // is the path that reaches the invoice loader at all.
    mocks.requestFindUnique.mockResolvedValue(
      adminRequest({ status: "REQUESTED" }),
    );
    mocks.loadInvoiceBlockers.mockResolvedValue(
      new Map([
        [
          "member-1",
          [
            {
              type: "unpaid_invoice",
              invoiceId: "inv-1",
              invoiceNumber: "INV-0042",
              invoiceStatus: "AUTHORISED",
              direction: "receivable",
              amountDueCents: 12050,
              currency: "NZD",
              dueDate: "2026-06-30",
              xeroUrl: null,
              xeroContactUrl: null,
            },
          ],
        ],
      ]),
    );

    await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "reject",
      adminMemberId: "admin-1",
    });

    // It went through: no 409, and no approval-blocked audit record.
    expect(mocks.transaction).toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
      }),
    );
    // The loader is still reached — the post-review reload rebuilds the queue's
    // advisory panels — but never with `fresh`, so a rejection spends no Xero
    // quota it does not have to.
    expect(mocks.loadInvoiceBlockers).toHaveBeenCalled();
    expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fresh: true }),
    );
  });

  // #2400: the reviewer is told, before they approve, that a shared family
  // invoice means no credit note will be raised. It is not itself a blocker —
  // the club is still owed that money by the members who remain.
  it("hands the reviewer the shared-invoice notice without blocking anything", async () => {
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "REQUESTED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(
      adminRequest({ status: "REQUESTED" }),
    );
    mocks.loadCreditPlans.mockResolvedValue(
      new Map([["member-1", sharedCreditPlan()]]),
    );

    const result = await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
    });

    expect(result.request.participants[0].sharedInvoiceNotice).toMatchObject({
      invoiceId: "inv-1",
      invoiceNumber: "INV-0042",
      sharedWith: [{ memberId: "member-2", name: "Bob Smith" }],
      blocksApproval: false,
      route: "cancel_others_first",
    });
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
      }),
    );
    expect(mocks.queueCancellationXeroOperations).toHaveBeenCalled();
  });

  // #2400 (review F7): the skip is otherwise recorded only on a Xero
  // sync-operation payload, which is not where anyone looks a year later.
  it("records in the audit trail that a credit note was deliberately not raised", async () => {
    mocks.loadCreditPlans.mockResolvedValue(
      new Map([["member-1", sharedCreditPlan()]]),
    );

    await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
    });

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.participant_cancelled",
        metadata: expect.objectContaining({
          sharedInvoiceUncredited: expect.objectContaining({
            invoiceId: "inv-1",
            invoiceNumber: "INV-0042",
            sharedWithMemberIds: ["member-2"],
            summary: expect.stringContaining("also covers Bob Smith"),
          }),
        }),
      }),
      expect.anything(),
    );
  });

  // #2400 (review F5): an API caller — or an admin approving from a stale
  // render — used to get only the generic "pay, credit or void it", which is
  // useless advice for a family invoice the club is still owed.
  it("tells a refused approver that the invoice in the way is the family's own", async () => {
    mocks.loadCreditPlans.mockResolvedValue(
      new Map([["member-1", sharedCreditPlan()]]),
    );
    mocks.loadInvoiceBlockers.mockResolvedValue(
      new Map([["member-1", [unpaidInvoiceBlocker()]]]),
    );

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(
        "If the rest of the family is leaving too, approve them first",
      ),
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        details: expect.stringContaining("which also covers Bob Smith"),
        metadata: expect.objectContaining({
          sharedInvoiceNotice: expect.objectContaining({
            invoiceId: "inv-1",
            blocksApproval: true,
          }),
        }),
      }),
    );
  });

  it("serializes no notice when the cancellation will credit the invoice in full", async () => {
    const result = await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
    });

    expect(result.request.participants[0].sharedInvoiceNotice).toBeNull();
  });

  it("prevents an admin from approving a cancellation request they initiated", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        request: {
          id: "request-1",
          status: "REQUESTED",
          reason: "Moving away",
          requestedByMemberId: "admin-1",
        },
      }),
    );

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a pending confirmation participant without cancelling the member", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        status: "PENDING_CONFIRMATION",
        confirmedAt: null,
        confirmationTokenHash: "hashed-token",
      }),
    );
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "REJECTED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(adminRequest({ status: "REJECTED" }));

    await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "reject",
      adminMemberId: "admin-1",
      adminNote: "Request withdrawn",
    });

    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.tx.membershipCancellationRequestParticipant.update).toHaveBeenCalledWith({
      where: { id: "participant-1" },
      data: expect.objectContaining({
        status: "REJECTED",
        adminNote: "Request withdrawn",
        confirmationTokenHash: null,
        confirmationTokenExpiresAt: null,
      }),
    });
    expect(mocks.sendRejectedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.org",
        participantName: "Alice Smith",
        adminNote: "Request withdrawn",
      }),
    );
  });

  describe("admin-account guards (#1604/#1622)", () => {
    it("blocks a scoped admin from cancelling an account holding a privileged role", async () => {
      // Target holds ADMIN; the acting admin is not a Full Admin
      // (actorIsFullAdmin count → 0), so the privileged-target guard trips.
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      mocks.tx.member.count.mockResolvedValue(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "officer-1",
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: PRIVILEGED_TARGET_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("blocks cancelling the last active Full Admin even for a Full Admin actor", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // actorIsFullAdmin → 1 (privileged-target passes); wouldRemoveLastFullAdmin
      // → target is an active Full Admin (1) with no other survivor (0).
      mocks.tx.member.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-2",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: LAST_FULL_ADMIN_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("allows a Full Admin to cancel an admin-holding account when another Full Admin survives", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // actorIsFullAdmin → 1; target is an active Full Admin (1) but another
      // survives (1), so wouldRemoveLastFullAdmin is false.
      mocks.tx.member.count.mockResolvedValue(1);

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-2",
      });

      expect(result.request.participants[0].status).toBe("CANCELLED");
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "member-1" },
        data: expect.objectContaining({ active: false, canLogin: false }),
      });
    });

    // #2383 made these guards reachable for a Full Admin target by the front
    // door: an admin's membership is now cancellable without first destroying
    // their access. The guards are the whole safety story for that, so they
    // are pinned from the widened path's point of view, not just #1604's.
    it("cannot strand the club with no Full Admin, whoever raised the request", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // actorIsFullAdmin → 1; target IS an active Full Admin (1); no other
      // active Full Admin survives (0).
      mocks.tx.member.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-2",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: LAST_FULL_ADMIN_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);

      // The invariant is end-state, not intent: nothing was written, and no
      // Xero cancellation was queued off the back of a rolled-back approval.
      expect(mocks.tx.member.update).not.toHaveBeenCalled();
      expect(mocks.queueCancellationXeroOperations).not.toHaveBeenCalled();
    });

    it("leaves the cancelled member's access-role rows in place", async () => {
      // Deliberate (#2383): cancellation is a lifecycle terminal, not a role
      // edit. What makes that safe is `active: false` — `requireAdmin`
      // (src/lib/session-guards.ts) refuses an inactive member, and every
      // server guard re-reads `active`. NOT `canLogin: false`: that guard does
      // not even select `canLogin`, and `getAdminPermissionMatrix` zeroes the
      // matrix only on an explicit `canLogin === false`, so retained rows read
      // without that field still resolve to the full bundle. The dormant rows
      // keep the member inside the #1604 privileged-target guard for any later
      // archive. Archive and deletion approval leave them in place too, so this
      // is the house rule, not a special case — and the reason nothing may
      // reactivate a cancelled member without dealing with the rows first.
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      mocks.tx.member.count.mockResolvedValue(1);

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-2",
      });

      const [[update]] = mocks.tx.member.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(update.data).not.toHaveProperty("accessRoles");
      expect(update.data).not.toHaveProperty("role");
      expect(update.data).not.toHaveProperty("financeAccessLevel");
    });
  });

  // #2383: with any account holder now cancellable, the approval queue is the
  // last place a human can catch an intended-but-mistaken approval — and it
  // showed nothing but name, email, age tier and login state, so "de-logins the
  // Treasurer" looked exactly like "cancels an ordinary member".
  describe("what the reviewer is shown (#2383)", () => {
    async function serializeParticipantOf(memberOverrides: Record<string, unknown>) {
      mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
        { status: "REJECTED" },
      ]);
      mocks.requestFindUnique.mockResolvedValue(
        adminRequest({ status: "REJECTED", member: memberOverrides }),
      );

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "reject",
        adminMemberId: "admin-2",
      });
      return result.request.participants[0];
    }

    it("marks a participant whose approval will need a Full Admin", async () => {
      // Same predicate as the approval-time guard, so the two cannot disagree.
      const scopedAdmin = await serializeParticipantOf({
        role: "USER",
        financeAccessLevel: "NONE",
        accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinitionId: null }],
      });
      expect(scopedAdmin.holdsPrivilegedAccess).toBe(true);
      expect(scopedAdmin.accountType).toBe("admin");
    });

    it("marks an organisation account as one", async () => {
      const org = await serializeParticipantOf({
        role: "SCHOOL",
        financeAccessLevel: "NONE",
        accessRoles: [{ role: "ORG", roleDefinitionId: null }],
      });
      expect(org.accountType).toBe("organisation");
      expect(org.holdsPrivilegedAccess).toBe(false);
    });

    it("leaves an ordinary member unmarked", async () => {
      const plain = await serializeParticipantOf({
        role: "USER",
        financeAccessLevel: "NONE",
        accessRoles: [{ role: "USER", roleDefinitionId: null }],
      });
      expect(plain.holdsPrivilegedAccess).toBe(false);
      expect(plain.accountType).toBe("user");
    });
  });

  // #2284 (S1): the reviewer is told when a NON-LOGIN member was put on the
  // request by someone else, because that member has no login to confirm with
  // and there is no second-adult signature — so the "Confirmed" stamp on their
  // row was recorded on their behalf, not personally given.
  describe("included-without-confirmation flag (#2284 S1)", () => {
    function seedQueue(request: ReturnType<typeof adminRequest>) {
      mocks.requestFindMany.mockResolvedValue([request]);
      mocks.requestCount.mockResolvedValue(1);
    }

    async function flagOf(request: ReturnType<typeof adminRequest>) {
      seedQueue(request);
      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: true,
      });
      return result.requests[0].participants[0]
        .includedWithoutOwnOrSecondAdultConfirmation;
    }

    it("flags a non-login member someone else put on the request", async () => {
      expect(await flagOf(adminRequest({ member: { canLogin: false } }))).toBe(
        true,
      );
    });

    it("does NOT flag a login-holding member — they confirm personally", async () => {
      // Mutation guard on the `!canLogin` conjunct.
      expect(await flagOf(adminRequest({ member: { canLogin: true } }))).toBe(
        false,
      );
    });

    it("does NOT flag the requester's own membership row, even with no login", async () => {
      // Mutation guard on the `memberId !== requestedByMemberId` conjunct: a
      // member acting on their OWN membership is not being acted on unheard.
      const flag = await flagOf(
        adminRequest({
          memberId: "requester-1",
          member: { id: "requester-1", canLogin: false },
          request: {
            id: "request-1",
            status: "REQUESTED",
            reason: "Leaving",
            requestedByMemberId: "requester-1",
          },
        }),
      );
      expect(flag).toBe(false);
    });
  });

  // #2383: an admin cancelling their OWN membership was previously unreachable
  // — the role gate refused an admin target, and the member-edit screen refuses
  // to demote yourself. It is now reachable through the front door, so the
  // separation-of-duties rule has to hold on it.
  describe("self-cancellation (#2383)", () => {
    function selfRequest(adminId: string) {
      // The admin raised the request against their own membership: they are
      // both `requestedByMemberId` and the participant member.
      mocks.participantFindUnique.mockResolvedValue(
        participant({
          memberId: adminId,
          member: member({ id: adminId }),
          request: {
            id: "request-1",
            status: "REQUESTED",
            reason: "Leaving the club",
            requestedByMemberId: adminId,
          },
        }),
      );
    }

    it("refuses to let the requester approve their own cancellation", async () => {
      selfRequest("admin-1");

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-1",
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: "Cancellation requests must be approved by a different admin.",
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses approval when the raiser is no longer on file", async () => {
      // `requestedByMemberId` is onDelete: SetNull, so hard-deleting the raiser
      // nulls it. The guard used to skip itself in that case — fail-open on the
      // only separation-of-duties check protecting the self-cancellation path
      // this widening newly reaches. "We cannot tell who raised this" now means
      // "not you", and rejecting the request is still available.
      mocks.participantFindUnique.mockResolvedValue(
        participant({
          memberId: "admin-1",
          member: member({ id: "admin-1" }),
          request: {
            id: "request-1",
            status: "REQUESTED",
            reason: "Leaving the club",
            requestedByMemberId: null,
          },
        }),
      );

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-1",
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();

      // ...and the same request can still be rejected, so nothing is stranded:
      // the guard runs on the approve branch only.
      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "reject",
          adminMemberId: "admin-1",
        }),
      ).resolves.toBeDefined();
    });

    it("refuses a solo Full Admin's self-cancellation even with a second reviewer", async () => {
      // The realistic departing-solo-admin case: someone else approves, but
      // there is no other active Full Admin to inherit the club.
      selfRequest("admin-1");
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      mocks.tx.member.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-2",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: LAST_FULL_ADMIN_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);
    });

    it("completes once a successor Full Admin exists and another admin approves", async () => {
      selfRequest("admin-1");
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // A successor survives the cancellation, so the invariant holds.
      mocks.tx.member.count.mockResolvedValue(1);

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-2",
      });

      expect(result.request.participants[0].status).toBe("CANCELLED");
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "admin-1" },
        data: expect.objectContaining({ active: false, canLogin: false }),
      });
    });
  });

  describe("admin notify choice (#1787)", () => {
    it("approve + notifyMember false: suppresses the email, audits the choice, still cancels the membership", async () => {
      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
        adminNote: "Approved by committee",
        notifyMember: false,
      });

      // Membership state change still applied.
      expect(result.request.participants[0].status).toBe("CANCELLED");
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "member-1" },
        data: expect.objectContaining({ active: false, canLogin: false }),
      });
      // No outcome email.
      expect(mocks.sendApprovedEmail).not.toHaveBeenCalled();
      // Suppression audited on the participant_cancelled record.
      const call = mocks.createAuditLog.mock.calls.find(
        (c) => c[0].action === "membership_cancellation.participant_cancelled",
      )?.[0];
      expect(call?.metadata).toMatchObject({ notifyMember: false });
    });

    it("approve + notifyMember true: emails the member and records no notify field", async () => {
      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
        notifyMember: true,
      });

      expect(mocks.sendApprovedEmail).toHaveBeenCalledTimes(1);
      const call = mocks.createAuditLog.mock.calls.find(
        (c) => c[0].action === "membership_cancellation.participant_cancelled",
      )?.[0];
      expect(call?.metadata).not.toHaveProperty("notifyMember");
    });

    it("reject + notifyMember false: suppresses the email, audits the choice, leaves the membership active", async () => {
      mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
        { status: "REJECTED" },
      ]);
      mocks.requestFindUnique.mockResolvedValue(
        adminRequest({ status: "REJECTED" }),
      );

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "reject",
        adminMemberId: "admin-1",
        adminNote: "Not this time",
        notifyMember: false,
      });

      // Reject never mutates the member.
      expect(mocks.tx.member.update).not.toHaveBeenCalled();
      expect(mocks.sendRejectedEmail).not.toHaveBeenCalled();
      const call = mocks.createAuditLog.mock.calls.find(
        (c) => c[0].action === "membership_cancellation.participant_rejected",
      )?.[0];
      expect(call?.metadata).toMatchObject({ notifyMember: false });
    });
  });

  /*
    #2402 — who the review queue spends a Xero call on.

    The unpaid-invoice check is a live, metered Xero read whose only use is to
    warn somebody before they press Approve. These tests pin the two halves of
    the owner's decision (31 Jul 2026): it runs for an admin who can approve and
    for a participant still awaiting approval, and for nobody else. The final
    group pins the thing that must NOT have moved with it — the approval-time
    check, which stays live, fresh and fail-closed.
  */
  describe("review queue Xero scope (#2402)", () => {
    /** Seed the queue reads with one page holding a single request. */
    function seedQueue(request: ReturnType<typeof adminRequest>) {
      mocks.requestFindMany.mockResolvedValue([request]);
      mocks.requestCount.mockResolvedValue(1);
    }

    /** A future booking on the member — the free, local half of the blocker set. */
    function seedFutureBooking() {
      mocks.bookingFindMany.mockResolvedValue([
        {
          id: "booking-1",
          memberId: "member-1",
          checkIn: new Date("2099-01-01T00:00:00.000Z"),
          checkOut: new Date("2099-01-03T00:00:00.000Z"),
          status: "PAID",
        },
      ]);
    }

    it("spends no Xero call for a view-only admin, and says so on the row", async () => {
      seedQueue(adminRequest());

      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: false,
      });

      // The whole point: Xero is never asked.
      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
      // The credit plans exist only to serve the invoice check and the notice
      // built from it, so they are asked about nobody. Expressed as an empty
      // member list rather than a second branch, so the skip cannot half-happen.
      expect(mocks.loadCreditPlans).toHaveBeenCalledWith([]);

      const [serialized] = result.requests[0].participants;
      expect(serialized.blockers).toEqual([]);
      expect(serialized.sharedInvoiceNotice).toBeNull();
      // …and the silence is declared, so an absent panel is never mistaken for
      // "this member owes nothing".
      expect(serialized.invoiceCheckSkipped).toBe(true);
    });

    it("still shows a view-only admin the free booking blockers (#2402 review, F1)", async () => {
      // The booking half is two local indexed reads with no external cost. It
      // was visible to every admin before this change and must stay visible:
      // withholding it saves the club nothing and takes away a real warning.
      seedQueue(adminRequest());
      seedFutureBooking();

      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: false,
      });

      expect(mocks.bookingFindMany).toHaveBeenCalled();
      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
      const [serialized] = result.requests[0].participants;
      expect(serialized.blockers).toEqual([
        expect.objectContaining({ type: "owned_booking", bookingId: "booking-1" }),
      ]);
      // Still true, and now precisely scoped: the MONEY half was skipped, the
      // booking half was not.
      expect(serialized.invoiceCheckSkipped).toBe(true);
    });

    it("still checks Xero for an admin who can approve, and shows what it found", async () => {
      seedQueue(adminRequest());
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([["member-1", [unpaidInvoiceBlocker()]]]),
      );

      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: true,
      });

      expect(mocks.loadInvoiceBlockers).toHaveBeenCalledWith(
        ["member-1"],
        expect.anything(),
      );
      const [serialized] = result.requests[0].participants;
      expect(serialized.blockers).toEqual([unpaidInvoiceBlocker()]);
      // An approver's checks DID run, so there is nothing to apologise for.
      expect(serialized.invoiceCheckSkipped).toBe(false);
    });

    it("does not check a participant whose outcome is already settled", async () => {
      // A rejected participant: no approval of this row is possible, so the
      // answer could not change anything anybody does.
      seedQueue(
        adminRequest({
          status: "REJECTED",
          reviewedAt: new Date("2026-05-25T00:00:00.000Z"),
        }),
      );

      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: true,
      });

      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
      const [serialized] = result.requests[0].participants;
      expect(serialized.blockers).toEqual([]);
      // Nothing to explain: the row's own status badge already says why there is
      // no approval preview, so the "not checked" line would be noise.
      expect(serialized.invoiceCheckSkipped).toBe(false);
    });

    it("does not even load the free booking half for a settled participant", async () => {
      // Condition 2 applies to BOTH halves: a rejected participant's future
      // bookings are nobody's problem, whoever is looking.
      seedQueue(adminRequest({ status: "REJECTED" }));
      seedFutureBooking();

      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: true,
      });

      expect(mocks.bookingFindMany).not.toHaveBeenCalled();
      expect(result.requests[0].participants[0].blockers).toEqual([]);
    });

    it("does not check a participant still awaiting the member's own confirmation", async () => {
      seedQueue(
        adminRequest({ status: "PENDING_CONFIRMATION", confirmedAt: null }),
      );

      await getAdminMembershipCancellationRequests({ viewerCanApprove: true });

      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
    });

    it("does not check a membership that is already inactive or cancelled", async () => {
      seedQueue(adminRequest({ member: { active: false } }));

      await getAdminMembershipCancellationRequests({ viewerCanApprove: true });

      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
    });

    it("marks nothing as skipped for a settled row, even for a view-only admin", async () => {
      mocks.requestFindMany.mockResolvedValue([
        { ...adminRequest({ status: "CANCELLED" }), status: "COMPLETED" },
      ]);
      mocks.requestCount.mockResolvedValue(1);

      const result = await getAdminMembershipCancellationRequests({
        viewerCanApprove: false,
      });

      expect(result.requests[0].participants[0].invoiceCheckSkipped).toBe(false);
    });
  });

  /*
    The queue's skip rule and the approval guards must answer the same question,
    or the promise "you are told about blockers before you press Approve" breaks
    silently. `assertParticipantCanBeApproved` and `assertRequestCanBeReviewed`
    are deliberately NOT rewritten in terms of the predicate — #2402 changes the
    render, not the approval path — so the agreement is held here instead: every
    shape is driven through BOTH, and the predicate must be true exactly when the
    guards let the approval reach its live Xero check.
  */
  describe("the skip rule agrees with the approval guards (#2402)", () => {
    const shapes: Array<{
      name: string;
      overrides: Record<string, unknown>;
      awaitingApproval: boolean;
    }> = [
      { name: "confirmed and ready", overrides: {}, awaitingApproval: true },
      {
        name: "the request has already been reviewed",
        overrides: {
          request: {
            id: "request-1",
            status: "REJECTED",
            reason: "Moving away",
            requestedByMemberId: "requester-1",
          },
        },
        awaitingApproval: false,
      },
      {
        name: "the participant has already been rejected",
        overrides: { status: "REJECTED" },
        awaitingApproval: false,
      },
      {
        name: "the member has not confirmed",
        overrides: { confirmedAt: null },
        awaitingApproval: false,
      },
      {
        name: "the membership is deactivated",
        overrides: { member: member({ active: false }) },
        awaitingApproval: false,
      },
      {
        name: "the membership is already cancelled",
        overrides: {
          member: member({ cancelledAt: new Date("2026-05-01T00:00:00.000Z") }),
        },
        awaitingApproval: false,
      },
    ];

    for (const shape of shapes) {
      it(`${shape.name}: predicate says ${shape.awaitingApproval}, and the approval guards agree`, async () => {
        const record = participant(shape.overrides);

        expect(
          isMembershipCancellationParticipantAwaitingApproval({
            requestStatus: record.request.status,
            status: record.status,
            confirmedAt: record.confirmedAt,
            member: record.member,
          }),
        ).toBe(shape.awaitingApproval);

        mocks.participantFindUnique.mockResolvedValue(record);
        const approving = reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-1",
        });

        if (shape.awaitingApproval) {
          await expect(approving).resolves.toBeDefined();
          // Reaching the guards means reaching the live check behind them.
          expect(mocks.loadInvoiceBlockers).toHaveBeenCalled();
        } else {
          await expect(approving).rejects.toBeInstanceOf(
            MembershipCancellationAdminError,
          );
          // Refused before it ever got as far as spending a Xero call.
          expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
        }
      });
    }
  });

  /*
    The one thing #2402 must not have touched. The queue's scope now depends on
    who is looking; the approval decision never does.
  */
  describe("the approval-time check is unchanged (#2402)", () => {
    it("always asks Xero live, and refuses on what it finds", async () => {
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([["member-1", [unpaidInvoiceBlocker()]]]),
      );

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-1",
        }),
      ).rejects.toBeInstanceOf(MembershipCancellationAdminError);

      // `fresh: true` is what bypasses the queue's 60s memo — the approval is
      // decided on a live answer, never on whatever the render happened to cache
      // (or, since #2402, happened not to load at all).
      expect(mocks.loadInvoiceBlockers).toHaveBeenCalledWith(
        ["member-1"],
        expect.objectContaining({ fresh: true }),
      );
      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses when Xero could not be asked at all, rather than approving", async () => {
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([
          [
            "member-1",
            [{ type: "invoice_check_unavailable", reason: "unavailable" }],
          ],
        ]),
      );

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-1",
        }),
      ).rejects.toBeInstanceOf(MembershipCancellationAdminError);
      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });
  });
});
