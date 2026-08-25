import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPrismaTransaction = vi.fn();
const mockTxMemberFindUnique = vi.fn();
const mockTxMemberUpdateMany = vi.fn();
const mockTxMemberFindMany = vi.fn();
const mockTxTokenDeleteMany = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ageTierSetting: {
      findMany: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
    },
    emailLog: {
      findFirst: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("../email", () => ({
  sendAgeUpInvitationEmail: vi.fn(),
  sendAgeUpParentEmailHandoffEmail: vi.fn(),
}));

vi.mock("../logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Best-effort Xero contact-group trigger (E8, #1934): mocked so we can assert
// it fires after a durable tier flip and never for skipped/handoff members.
const mockTriggerGroupSync = vi.fn();
vi.mock("../xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) =>
    mockTriggerGroupSync(...args),
}));

import { prisma } from "../prisma";
import {
  sendAgeUpInvitationEmail,
  sendAgeUpParentEmailHandoffEmail,
} from "../email";
import { AGE_TIER_DEFAULTS, invalidateAgeTierCache } from "../age-tier";
import { getAuditRetentionExpiresAt } from "../audit";
import { checkAgeUpMembers } from "../cron-age-up";
import { withTimeZoneAsync } from "./helpers/timezone";
import {
  EMAIL_SENT,
  emailWithheldForEnvironment,
} from "@/lib/__tests__/helpers/email-outcomes";

const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockedMemberFindUnique = vi.mocked(prisma.member.findUnique);
const mockedUpdate = vi.mocked(prisma.member.update);
const mockedAgeTierSettingsFindMany = vi.mocked(prisma.ageTierSetting.findMany);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedEmailLogFind = vi.mocked(prisma.emailLog.findFirst);
const mockedAuditLogFind = vi.mocked(prisma.auditLog.findFirst);
const mockedAuditLogCreate = vi.mocked(prisma.auditLog.create);
const mockedSendEmail = vi.mocked(sendAgeUpInvitationEmail);
const mockedSendHandoffEmail = vi.mocked(sendAgeUpParentEmailHandoffEmail);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgeTierCache();
  mockedAgeTierSettingsFindMany.mockResolvedValue(
    AGE_TIER_DEFAULTS.map((setting) => ({
      ...setting,
      xeroAcceptedContactGroups: [],
    })) as any
  );
  mockPrismaTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        member: {
          findUnique: mockTxMemberFindUnique,
          update: mockedUpdate,
          updateMany: mockTxMemberUpdateMany,
          // #2255: after clearing the aged-up member's own inheritance, the job
          // re-resolves their dependants' DERIVED pointers through them — those
          // pointers had walked PAST this member precisely because they had no
          // address. Defaulted to "no dependants", which is what most fixtures
          // here describe; the dedicated case below overrides it.
          findMany: mockTxMemberFindMany,
        },
        passwordResetToken: {
          create: mockedCreateToken,
          deleteMany: mockTxTokenDeleteMany,
        },
      })
  );
  mockedMemberFindFirst.mockResolvedValue(null);
  mockedMemberFindUnique.mockResolvedValue(null);
  mockedAuditLogFind.mockResolvedValue(null);
  mockedAuditLogCreate.mockResolvedValue({} as any);
  mockTxMemberFindUnique.mockResolvedValue({
    canLogin: false,
    ageTier: "YOUTH",
    inheritEmailFromId: null,
    inheritParentEmail: false,
    parentMemberId: null,
  });
  mockTxMemberUpdateMany.mockResolvedValue({ count: 1 });
  mockTxMemberFindMany.mockResolvedValue([]);
  mockTxTokenDeleteMany.mockResolvedValue({ count: 1 });
});

/**
 * A date of birth that reaches exactly `age` at the 1 April 2026 season start,
 * stored the way every correct writer stores one: the calendar day at UTC
 * midnight (INV-DATE-024).
 *
 * IT USED TO BE `new Date(2026 - age, 3, 1)`, host-local midnight, which
 * INV-DATE-024 names as the forbidden spelling for this column and which
 * `computeAge`'s stored-day guard now refuses outright (#3082). Under
 * `Pacific/Auckland` that fixture was `(D-1)T11:00Z` — not a stored calendar day
 * at all, and a day early on top.
 */
function dobForAge(age: number): Date {
  return new Date(`${2026 - age}-04-01T00:00:00.000Z`);
}

/** A member row as `resolveInheritedEmailSourceId` selects one. */
function familyRow(
  overrides: { id: string; email: string } & Partial<{
    ageTier: string;
    archivedAt: Date | null;
    inheritEmailFromId: string | null;
    parentMemberId: string | null;
    secondaryParentId: string | null;
  }>,
) {
  return {
    ageTier: "ADULT",
    archivedAt: null,
    inheritEmailFromId: null,
    inheritEmailChoiceId: null,
    parentMemberId: null,
    secondaryParentId: null,
    firstName: overrides.id,
    lastName: "Member",
    ...overrides,
  };
}

/**
 * #2282: the legacy parent handoff no longer mails the raw parent link — it
 * resolves the family's actual contact of record with
 * `resolveInheritedEmailSourceId`, the same rule every write path uses.
 *
 * #2716 changed how that reads. One-hop resolution reads ONE row through
 * `prisma.member.findUnique` instead of walking levels through `findMany`, so
 * the family is served from `findUnique` here. The candidate query keeps
 * `findMany` to itself, which makes the two unambiguous.
 */
function mockCandidatesAndFamily(
  candidates: unknown[],
  family: Record<string, ReturnType<typeof familyRow>>,
) {
  mockedFindMany.mockResolvedValue(candidates as never);
  mockedMemberFindUnique.mockImplementation((async (args: unknown) => {
    const id = (args as { where?: { id?: string } })?.where?.id;
    return (id ? (family[id] ?? null) : null) as never;
  }) as never);
}

describe("checkAgeUpMembers", () => {
  /**
   * #2255 (M3), rewritten by #2716. Age-up moves a member across the line
   * between "can receive mail" and "cannot", in the helpful direction: until
   * this morning they were a non-login minor with no address of their own, so
   * any dependant who had chosen them as their contact of record resolved to
   * nobody.
   *
   * WHAT CHANGED. The job used to run a sweep of its own, because the only
   * record of a dependant's routing was a flat pointer plus `inheritParentEmail`
   * — a flag that says "derived" but cannot say "derived from whom", and that
   * carries `@default(true)` besides. It approximated the answer with "does the
   * pointer name this member or one of their own ancestors", and the tests here
   * pinned that approximation. The choice column removes the guess, so this now
   * calls the same reconciliation every other writer calls, and a dependant is
   * re-resolved exactly when they NAMED this member.
   */
  describe("dependants' inherited email follows the member up (#2716)", () => {
    /**
     * The aged-up member plus a family, served through the reconciliation's two
     * query shapes: "these ids" (the subjects, and their chosen sources) and the
     * `OR` fan-out that finds everyone depending on a member.
     */
    function agingMemberWithFamily(
      family: Array<{
        id: string;
        email?: string;
        ageTier?: string;
        inheritParentEmail?: boolean;
        parentMemberId?: string | null;
        secondaryParentId?: string | null;
        inheritEmailFromId?: string | null;
        inheritEmailChoiceId?: string | null;
      }>,
    ) {
      const rows = family.map((row) => ({
        email: `${row.id}@example.com`,
        ageTier: "ADULT",
        archivedAt: null,
        active: true,
        inheritParentEmail: true,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
        ...row,
      }));
      const byId = new Map(rows.map((row) => [row.id, row]));

      mockedFindMany.mockResolvedValue([
        {
          id: "m1",
          email: "youth@example.com",
          firstName: "Alice",
          lastName: "Smith",
          dateOfBirth: dobForAge(18),
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
          inheritEmailFrom: null,
        },
      ] as any);
      mockedEmailLogFind.mockResolvedValue(null);
      mockedUpdate.mockResolvedValue({} as any);
      mockedCreateToken.mockResolvedValue({} as any);
      mockedSendEmail.mockResolvedValue(EMAIL_SENT);

      // The upgrade write happens through `member.update`, and reconciliation
      // reads AFTER it — so the fake applies it, exactly as the database would.
      // Without that the aged-up member would still read as a minor and every
      // assertion below would be about the wrong world.
      mockedUpdate.mockImplementation((async ({ where, data }: any) => {
        const row = byId.get(where.id);
        if (row) Object.assign(row, data);
        return {};
      }) as never);

      mockTxMemberFindMany.mockImplementation(async ({ where }: any) => {
        if (where?.id?.in) {
          return where.id.in
            .map((id: string) => byId.get(id))
            .filter(Boolean)
            .map((row: any) => ({ ...row }));
        }
        if (where?.OR) {
          const ids = new Set<string>(
            where.OR.flatMap((clause: any) => [
              ...(clause.inheritEmailChoiceId?.in ?? []),
              ...(clause.inheritEmailFromId?.in ?? []),
              ...(clause.parentMemberId?.in ?? []),
              ...(clause.secondaryParentId?.in ?? []),
            ]),
          );
          return rows
            .filter(
              (row) =>
                (row.inheritEmailChoiceId && ids.has(row.inheritEmailChoiceId)) ||
                (row.inheritEmailFromId && ids.has(row.inheritEmailFromId)) ||
                (row.inheritEmailChoiceId &&
                  ((row.parentMemberId && ids.has(row.parentMemberId)) ||
                    (row.secondaryParentId && ids.has(row.secondaryParentId)))),
            )
            .map((row) => ({ ...row }));
        }
        return [];
      });

      return byId;
    }

    /** Every `member.update` that wrote the effective pointer. */
    function pointerWrites() {
      return mockedUpdate.mock.calls
        .map(([args]: any) => args)
        .filter((args: any) => args?.data?.inheritEmailFromId !== undefined
          && args?.data?.ageTier === undefined);
    }

    it("re-points a dependant who chose this member, now that they can receive mail", async () => {
      agingMemberWithFamily([
        { id: "m1", email: "youth@example.com", ageTier: "YOUTH" },
        {
          id: "kid-1",
          ageTier: "CHILD",
          email: "walk-in-1@no-email.invalid",
          parentMemberId: "m1",
          inheritEmailChoiceId: "m1",
          inheritEmailFromId: null,
        },
      ]);

      await checkAgeUpMembers();

      expect(pointerWrites()).toEqual([
        { where: { id: "kid-1" }, data: { inheritEmailFromId: "m1" } },
      ]);
    });

    it("leaves a dependant who chose the OTHER parent alone", async () => {
      // The consent question the old heuristic had to reason about, and now
      // simply does not arise: the child named parent-q, so parent-q they keep.
      agingMemberWithFamily([
        { id: "m1", email: "youth@example.com", ageTier: "YOUTH" },
        { id: "parent-q", email: "q@example.com" },
        {
          id: "kid-1",
          ageTier: "CHILD",
          email: "walk-in-1@no-email.invalid",
          parentMemberId: "m1",
          secondaryParentId: "parent-q",
          inheritEmailChoiceId: "parent-q",
          inheritEmailFromId: "parent-q",
        },
      ]);

      await checkAgeUpMembers();

      expect(pointerWrites()).toEqual([]);
    });

    it("writes nothing when the member has no dependants", async () => {
      agingMemberWithFamily([
        { id: "m1", email: "youth@example.com", ageTier: "YOUTH" },
      ]);

      await checkAgeUpMembers();

      expect(pointerWrites()).toEqual([]);
    });
  });

  it("should upgrade a YOUTH member who turned 18", async () => {
    const member = {
      id: "m1",
      email: "youth@example.com",
      firstName: "Alice",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Check member was updated
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        canLogin: true,
        ageTier: "ADULT",
        inheritEmailFromId: null,
        // #2716: the CHOICE clears with the pointer. Leaving it would have the
        // reconciliation that runs immediately afterwards hand the pointer
        // straight back, undoing the upgrade's own write.
        inheritEmailChoiceId: null,
        inheritParentEmail: false,
      },
    });

    // Check password reset token was created
    expect(mockedCreateToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "m1",
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    });

    // Check email was sent
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "youth@example.com",
      "Alice",
      expect.any(String),
      expect.objectContaining({
        targetAgeTier: "ADULT",
        targetAgeTierLabel: "Adult (18+)",
        targetAgeTierMinAge: 18,
      })
    );

    // E8 (#1934): the best-effort Xero contact-group re-sync fires after the
    // tier flip has committed.
    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("m1", {
      reason: "cron_age_up",
    });
  });

  it("does not fire the Xero contact-group trigger when the flip is skipped (parent handoff)", async () => {
    const member = {
      id: "m-handoff",
      email: "shared@example.com",
      firstName: "Kid",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: "parent-1",
      inheritEmailFrom: { id: "parent-1", email: "shared@example.com" },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: "parent-1",
      inheritParentEmail: false,
      parentMemberId: null,
    });
    mockedSendHandoffEmail.mockResolvedValue(undefined as any);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    // No tier flip happened, so no grouping trigger fires.
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("upgrades normally once the member has a unique email and inheritance is cleared", async () => {
    const member = {
      id: "m-unique-family-link",
      email: "unique-youth@example.com",
      firstName: "Una",
      lastName: "Unique",
      dateOfBirth: dobForAge(18),
      parentMemberId: "parent-keep",
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "parent-keep",
        email: "parent-keep@example.com",
        firstName: "Keep",
        lastName: "Parent",
      },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: "parent-keep",
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    expect(result.handoff).toBe(0);
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m-unique-family-link" },
      data: {
        canLogin: true,
        ageTier: "ADULT",
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
        inheritParentEmail: false,
      },
    });
    expect((mockedUpdate.mock.calls[0]![0] as any).data).not.toHaveProperty(
      "parentMemberId"
    );
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "unique-youth@example.com",
      "Una",
      expect.any(String),
      expect.objectContaining({
        targetAgeTierLabel: "Adult (18+)",
      })
    );
  });

  /**
   * The IN-TRANSACTION re-check, which nothing exercised (found by mutation
   * probe while re-verifying #2282's safeguarding claims: blanking the whole
   * in-transaction condition left the suite green, because every existing case
   * is decided by `resolveAgeUpParentEmailHandoff` on the candidate row read
   * OUTSIDE the transaction).
   *
   * It is not redundant. The candidate list is read, then each member is
   * processed one at a time, so an admin can link a member as an inheriting
   * dependant in between — and under READ COMMITTED the transaction sees that
   * write while the candidate row in memory does not. Without this clause the
   * job would enable a login and clear the inheritance that had just been set,
   * which is the one automatic action in the system that can hand a minor's
   * mailbox back to them without anyone deciding to.
   *
   * Mutation probe: replace the `currentMember.inheritEmailFromId || (...)`
   * condition with `false` and this test upgrades the member instead.
   */
  it("abandons the upgrade when inheritance appears between the read and the write", async () => {
    const member = {
      id: "m-race",
      email: "race@example.com",
      firstName: "Rae",
      lastName: "Race",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);
    // The transaction's own view: a link landed while this member was queued.
    // ONLY the resolved-source column is set, so this test isolates the first
    // half of the disjunction — with `inheritParentEmail`/`parentMemberId` also
    // set, the legacy half would catch it and the first half could be deleted
    // with the suite still green (which is exactly what the probe found).
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: "parent-late",
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("abandons the upgrade when only the CHOICE says they inherit (#2716)", async () => {
    // The third half of the disjunction, and the one #2716 created. INV-LIFE-036
    // withholds a login from a member whose email is inherited, and "inherited"
    // used to be exactly `inheritEmailFromId != null`. After the two-column
    // split it is not: a null pointer beside a live CHOICE is the ordinary state
    // of somebody still inheriting whose source has gone temporarily
    // unreachable. Testing the pointer alone aged them up, gave them a login,
    // and sent the invitation to whatever stale copy sat in their own `email`
    // column — an address that is somebody else's mailbox.
    //
    // Every other test in this file seeds `inheritEmailChoiceId: null`, which is
    // why the gap survived review of the change that opened it.
    const member = {
      id: "m-choice-only",
      email: "choice@example.com",
      firstName: "Cass",
      lastName: "Choice",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      // Pointer null, choice live — the state the split makes normal.
      inheritEmailFromId: null,
      inheritEmailChoiceId: "chosen-parent",
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("abandons the upgrade on a LEGACY inheritance appearing mid-run", async () => {
    // The second half of the same disjunction — `inheritParentEmail` with a
    // parent but no resolved source — so deleting either half fails a test.
    const member = {
      id: "m-race-legacy",
      email: "race2@example.com",
      firstName: "Rob",
      lastName: "Race",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: true,
      parentMemberId: "parent-late",
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  /**
   * The rest of the same in-transaction condition (#2282 review). A later
   * mutation sweep found three conjuncts still surviving: dropping
   * `&& parentMemberId`, `currentMember.canLogin ||`, and
   * `currentMember.ageTier === "ADULT" ||` all left the suite green, so the
   * clause was only a third pinned. Each case below kills exactly one.
   */
  function racingMember(id: string) {
    return {
      id,
      email: `${id}@example.com`,
      firstName: "Race",
      lastName: "Case",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };
  }

  it("abandons the upgrade when a login is enabled between the read and the write", async () => {
    // `canLogin` is what stops the job issuing a SECOND password-reset token and
    // invitation to a member who was given a login mid-run.
    mockedFindMany.mockResolvedValue([racingMember("m-login")] as never);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: true,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("abandons the upgrade when the member is already ADULT in the transaction", async () => {
    mockedFindMany.mockResolvedValue([racingMember("m-adult")] as never);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "ADULT",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("upgrades a member whose inheritParentEmail flag stands with no parent", async () => {
    // The `&& parentMemberId` half. A member detached by a cancellation or a
    // hard delete can be left carrying `inheritParentEmail: true` with no parent
    // and no source — inheriting from nobody. There is nothing to protect, so
    // dropping that conjunct (making the flag alone disqualifying) would strand
    // exactly these members at YOUTH for ever.
    mockedFindMany.mockResolvedValue([racingMember("m-stranded")] as never);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as never);
    mockedCreateToken.mockResolvedValue({} as never);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: true,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    expect(mockedUpdate).toHaveBeenCalled();
  });

  it("should skip members who already received age-up email", async () => {
    const member = {
      id: "m2",
      email: "already@example.com",
      firstName: "Bob",
      lastName: "Jones",
      dateOfBirth: dobForAge(19),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue({ id: "el1" } as any);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("sends parent handoff and does not update or tokenize when inheritEmailFromId is set", async () => {
    const member = {
      id: "m3",
      email: "child@placeholder.com",
      firstName: "Charlie",
      lastName: "Brown",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: {
        id: "parent1",
        email: "parent@example.com",
        firstName: "Pat",
        lastName: "Parent",
      },
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedSendHandoffEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "parent@example.com",
      expect.objectContaining({
        recipientName: "Pat Parent",
        memberFirstName: "Charlie",
        memberLastName: "Brown",
        targetAgeTierLabel: "Adult (18+)",
        targetAgeTierMinAge: 18,
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "m3",
        entityType: "Member",
        entityId: "m3",
        metadata: expect.objectContaining({
          handoffReason: "inheritEmailFrom",
          sourceMemberId: "parent1",
        }),
      }),
    });
  });

  it("gives the handoff audit row an expiry instead of keeping it forever (#2581)", async () => {
    /*
      WHAT THIS CATCHES: this writer going back to a hand-built
      `prisma.auditLog.create({ data: … })`.

      It carried `category: "communication"` even while hand-built, so every
      category-shaped assertion passed and the defect was invisible: bypassing
      `buildStructuredAuditLogCreateData` meant no `retentionClass` and no
      `expiresAt`, neither of which has a schema default and neither of which any
      Prisma middleware fills. A NULL/NULL row is never archived
      (`archiveEligibleAuditLogs` filters on `retentionClass`) and never pruned
      (`pruneExpiredAuditLogs` carries `expiresAt: { lt: now }` on every branch,
      and NULL is not less than anything) — so a row naming a member and a
      recipient EMAIL ADDRESS was kept for the life of the database.

      The category pin above cannot catch that. This one can, and it is the
      behavioural half of the per-sink pin in the census manifest.
    */
    const member = {
      id: "m-retention",
      email: "child@placeholder.com",
      firstName: "Charlie",
      lastName: "Brown",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: {
        id: "parent1",
        email: "parent@example.com",
        firstName: "Pat",
        lastName: "Parent",
      },
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedSendHandoffEmail.mockResolvedValue(EMAIL_SENT);

    await checkAgeUpMembers();

    const data = mockedAuditLogCreate.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data.retentionClass).toBe("critical");
    expect(data.expiresAt).toEqual(getAuditRetentionExpiresAt("critical"));
    // And the payload the boundary now sanitises still says what it said, so the
    // routing is a retention/sanitisation change and not a content change.
    expect(data.metadata).toEqual(
      expect.objectContaining({
        handoffReason: "inheritEmailFrom",
        recipientEmail: "parent@example.com",
        sourceMemberId: "parent1",
        targetAgeTier: "ADULT",
      }),
    );
  });

  it("sends parent handoff for legacy inheritParentEmail with parentMemberId", async () => {
    const member = {
      id: "m-legacy",
      email: "legacy-child@example.com",
      firstName: "Lee",
      lastName: "Legacy",
      dateOfBirth: dobForAge(18),
      parentMemberId: "parent-legacy",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "parent-legacy",
        email: "legacy-parent@example.com",
        firstName: "Jordan",
        lastName: "Parent",
      },
    };

    mockCandidatesAndFamily([member], {
      "parent-legacy": familyRow({
        id: "parent-legacy",
        email: "legacy-parent@example.com",
      }),
    });
    mockedSendHandoffEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "legacy-parent@example.com",
      expect.objectContaining({
        recipientName: "Jordan Parent",
        memberFirstName: "Lee",
        memberLastName: "Legacy",
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectMemberId: "m-legacy",
        metadata: expect.objectContaining({
          handoffReason: "legacyParentEmail",
          sourceMemberId: "parent-legacy",
        }),
      }),
    });
  });

  /**
   * #2282 review, narrowed by #2716. The legacy branch mailed
   * `member.parent.email` outright, which was only ever safe because a parent
   * link implied an active adult — the rule #2282 removed. A minor parent, an
   * archived one, or one whose only address is a club-internal placeholder would
   * otherwise receive (or silently fail to receive) another member's age-up
   * notice.
   *
   * What #2716 changed is the REMEDY, not the gate. The branch used to route on
   * up to the grandparent; now it declines, and the age-up falls through to the
   * shared-login recipient or to nobody. A grandparent who supplies an email for
   * one grandchild does not thereby expect another member's lifecycle mail.
   *
   * Mutation probe: put `member.parent?.email` back in place of the resolved
   * source and this test mails the 16-year-old.
   */
  it("declines the legacy handoff rather than mailing a young parent, or anyone above them", async () => {
    const member = {
      id: "m-young-parent",
      email: "kid@example.com",
      firstName: "Kea",
      lastName: "Rangi",
      dateOfBirth: dobForAge(18),
      parentMemberId: "tui",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "tui",
        email: "tui@example.com",
        firstName: "Tui",
        lastName: "Rangi",
      },
    };

    mockCandidatesAndFamily([member], {
      tui: familyRow({
        id: "tui",
        email: "tui@example.com",
        ageTier: "YOUTH",
        parentMemberId: "nan",
      }),
      nan: familyRow({ id: "nan", email: "nan@example.com" }),
    });
    mockedSendHandoffEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(0);
    expect(mockedSendHandoffEmail).not.toHaveBeenCalled();
  });

  it("declines the legacy handoff when the family reaches nobody", async () => {
    // No adult anywhere above the parent. Mailing the minor was the old
    // behaviour; the member is left for a human instead, because the
    // in-transaction guard then refuses the upgrade too.
    const member = {
      id: "m-no-source",
      email: "kid2@example.com",
      firstName: "Kim",
      lastName: "Rangi",
      dateOfBirth: dobForAge(18),
      parentMemberId: "tui",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "tui",
        email: "tui@example.com",
        firstName: "Tui",
        lastName: "Rangi",
      },
    };

    mockCandidatesAndFamily([member], {
      tui: familyRow({
        id: "tui",
        email: "tui@example.com",
        ageTier: "YOUTH",
      }),
    });
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: true,
      parentMemberId: "tui",
    });

    const result = await checkAgeUpMembers();

    expect(mockedSendHandoffEmail).not.toHaveBeenCalled();
    expect(result.handoff).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("sends parent handoff when the youth email matches another login member", async () => {
    const member = {
      id: "m-shared",
      email: "shared@example.com",
      firstName: "Sam",
      lastName: "Shared",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedMemberFindFirst.mockResolvedValue({
      id: "login-holder",
      email: "shared@example.com",
      firstName: "Alex",
      lastName: "Holder",
    } as any);
    mockedSendHandoffEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "shared@example.com",
      expect.objectContaining({
        recipientName: "Alex Holder",
        memberFirstName: "Sam",
        memberLastName: "Shared",
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectMemberId: "m-shared",
        metadata: expect.objectContaining({
          handoffReason: "sharedLoginEmail",
          sourceMemberId: "login-holder",
        }),
      }),
    });
  });

  it("dedupes handoff per youth member rather than recipient email", async () => {
    const parent = {
      id: "parent1",
      email: "parent@example.com",
      firstName: "Pat",
      lastName: "Parent",
    };
    const member1 = {
      id: "handoff-already",
      email: "one@example.com",
      firstName: "One",
      lastName: "Youth",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: parent,
      parent: null,
    };
    const member2 = {
      id: "handoff-new",
      email: "two@example.com",
      firstName: "Two",
      lastName: "Youth",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: parent,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedAuditLogFind
      .mockResolvedValueOnce({ id: "existing-audit" } as any)
      .mockResolvedValueOnce(null);
    mockedSendHandoffEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "parent@example.com",
      expect.objectContaining({
        memberFirstName: "Two",
        memberLastName: "Youth",
      })
    );
    expect(mockedAuditLogFind).toHaveBeenNthCalledWith(1, {
      where: {
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "handoff-already",
        outcome: "success",
      },
      select: { id: true },
    });
    expect(mockedAuditLogFind).toHaveBeenNthCalledWith(2, {
      where: {
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "handoff-new",
        outcome: "success",
      },
      select: { id: true },
    });
  });

  it("should handle no candidates gracefully", async () => {
    mockedFindMany.mockResolvedValue([]);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(result.handoff).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should skip member with null dateOfBirth", async () => {
    const member = {
      id: "m4",
      email: "nodob@example.com",
      firstName: "Dee",
      lastName: "NoDob",
      dateOfBirth: null,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);

    const result = await checkAgeUpMembers();

    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("does not age-up a member concurrently flipped to N/A (#2106 MINOR-7)", async () => {
    const member = {
      id: "m-na",
      email: "na@example.com",
      firstName: "Nora",
      lastName: "Na",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    // The in-transaction re-read sees a member who was flipped to N/A after the
    // batch selection — the re-check must short-circuit and leave them alone.
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "NOT_APPLICABLE",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("should count failed members when update throws", async () => {
    const member = {
      id: "m5",
      email: "fail@example.com",
      firstName: "Eve",
      lastName: "Fail",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockRejectedValue(new Error("DB error"));

    const result = await checkAgeUpMembers();

    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
  });

  it("should roll back the member upgrade and setup token when email delivery fails", async () => {
    const member = {
      id: "m-email-fail",
      email: "email-fail@example.com",
      firstName: "Failure",
      lastName: "Retry",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockRejectedValue(new Error("SMTP down"));

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
    expect(mockTxTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        memberId: "m-email-fail",
        tokenHash: expect.any(String),
        used: false,
      },
    });
    expect(mockTxMemberUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "m-email-fail",
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: "YOUTH",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });
  });

  it("should process multiple members independently", async () => {
    const member1 = {
      id: "m6",
      email: "a@example.com",
      firstName: "Aaa",
      lastName: "One",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };
    const member2 = {
      id: "m7",
      email: "b@example.com",
      firstName: "Bbb",
      lastName: "Two",
      dateOfBirth: dobForAge(20),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(2);
    expect(result.upgraded).toBe(2);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedSendEmail).toHaveBeenCalledTimes(2);
  });

  it("should create a 7-day expiry token", async () => {
    const member = {
      id: "m8",
      email: "token@example.com",
      firstName: "Frank",
      lastName: "Token",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);

    await checkAgeUpMembers();

    const tokenCall = mockedCreateToken.mock.calls[0][0];
    const expiresAt = (tokenCall as any).data.expiresAt as Date;
    const now = Date.now();
    // Should expire in ~7 days (allow 1 minute tolerance)
    const diffDays = (expiresAt.getTime() - now) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("should query for the correct member criteria", async () => {
    mockedFindMany.mockResolvedValue([]);

    // #2872: the club's own zone is FORCED, not inherited, and without that this
    // test could not tell the fix from the defect of its day. `getSeasonStartDate`
    // built HOST-local midnight; the bound had to be the calendar DAY at UTC
    // midnight. On a UTC runner — which is what CI is — those two are the same
    // instant, so every assertion below would have passed against a
    // local-midnight bound as happily as against a correct one.
    //
    // #3082 moved the season start itself onto a calendar day, so the two are no
    // longer different shapes to confuse. The pin STAYS: it is now what proves
    // the bound cannot be moved by the container at all, and a regression that
    // reintroduced a host-local read would fail here rather than only on a
    // behind-Greenwich host (docs/TESTING.md rules 6 and 7).
    await withTimeZoneAsync("Pacific/Auckland", () => checkAgeUpMembers());

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: {
        active: true,
        canLogin: false,
        // NOT_APPLICABLE (organisations/schools, #1440) must never age up.
        ageTier: { notIn: ["ADULT", "NOT_APPLICABLE"] },
        dateOfBirth: {
          not: null,
          // #2859: an exclusive bound on the END of the cutoff calendar day,
          // not `lte` the cutoff instant. The two sides of this comparison are
          // encoded differently — a local-midnight cutoff against a UTC-midnight
          // date of birth — so the member born on exactly the season-start
          // anniversary used to fall out of the candidate set.
          lt: expect.any(Date),
        },
      },
      select: expect.objectContaining({
        id: true,
        email: true,
        firstName: true,
        dateOfBirth: true,
        parentMemberId: true,
        inheritParentEmail: true,
        inheritEmailFromId: true,
        inheritEmailFrom: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        parent: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      }),
    });

    // Verify the cutoff day is 18 years before season start (April 1, 2026),
    // i.e. April 1, 2008. #2859: the bound is EXCLUSIVE on the day AFTER that,
    // so a member born on 1 April 2008 — who turns 18 on season start and is an
    // adult that season — is inside the candidate set.
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    const cutoffWindowEnd = cutoff.lt as Date;
    // #2872: the bound is now a CALENDAR DAY at UTC midnight, not local midnight
    // on that day, because `Member.dateOfBirth` is `@db.Date` and the adapter
    // narrows such a bound to its UTC date. Read it with the UTC getters — the
    // local ones would answer 1 April on a host west of UTC and pass here on the
    // very shape the change exists to prevent.
    expect(cutoffWindowEnd.getUTCFullYear()).toBe(2008);
    expect(cutoffWindowEnd.getUTCMonth()).toBe(3); // April
    expect(cutoffWindowEnd.getUTCDate()).toBe(2);
    // Pinned as an exact instant so a widening beyond one day cannot pass, and
    // as an explicit UTC literal rather than `new Date(2008, 3, 2)` — the
    // local-midnight constructor no longer describes what the code builds, and
    // asserting against it would make this test agree with the defect on the
    // club's own host while failing everywhere else (docs/TESTING.md rule 6).
    expect(cutoffWindowEnd.toISOString()).toBe("2008-04-02T00:00:00.000Z");
    // THE POINT OF THE WHOLE BOUND: the entire day of 1 April 2008 is inside the
    // window. A date of birth is stored at UTC midnight, so this is the row that
    // the pre-#2859 `lte` instant bound excluded, and that a local-midnight
    // bound against the now-`@db.Date` column would exclude again — the adapter
    // would narrow 2008-04-01T11:00Z to the DATE 2008-04-01, making the
    // comparison `< 2008-04-01` and dropping this member for a whole season.
    expect(new Date("2008-04-01T00:00:00.000Z").getTime()).toBeLessThan(
      cutoffWindowEnd.getTime(),
    );
  });

  // #2859. The two tests above pin the SHAPE of the widened bound. These two
  // pin the OUTCOME either side of it, which is the thing that actually decides
  // a member's price and whether they may host — and neither was covered.
  //
  // The zone is forced rather than inherited (docs/TESTING.md rules 6 and 7).
  //
  // #3082 IS THE OTHER HALF OF WHAT THIS COMMENT USED TO SAY. It read: "under a
  // host WEST of UTC the day-after member would be promoted a year early,
  // because UTC midnight is the previous evening locally: that is a pre-existing
  // `computeAge` defect (INV-DATE-024 records it) ... and it is deliberately not
  // fixed here." That was exactly right, and it was measured afterwards at 161
  // of the 418 zones this runtime knows. It is fixed now — both sides read one
  // calendar frame — so the second of these two tests runs behind Greenwich as
  // well, which is where it used to give the wrong answer.
  it("promotes the member born on exactly the season-start anniversary", async () => {
    const member = {
      id: "m-boundary-on",
      email: "boundary@example.com",
      firstName: "Bo",
      lastName: "Boundary",
      // Stored the way every correct writer stores it, and the way the #2859
      // migration re-encodes a repaired row: UTC midnight on 1 April 2008. They
      // turn 18 on season start (1 April 2026) and are an adult that season.
      dateOfBirth: new Date("2008-04-01T00:00:00.000Z"),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);

    const result = await withTimeZoneAsync("Pacific/Auckland", () =>
      checkAgeUpMembers(),
    );

    // The authority agrees with the widened prefilter. Before #2859 this member
    // never reached `computeAgeTierWithSettings` at all: the old `lte` bound was
    // 2008-03-31T11:00Z under the club pin, so a UTC-midnight date of birth on
    // 1 April sat AFTER it and was filtered out — one season late for their own
    // age-up, with nothing on any screen saying so.
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    // Both halves, in one place. The assertions above prove the AUTHORITY
    // promotes this member; this one proves the PREFILTER would really have
    // handed them to it, by checking their stored date of birth against the
    // window the job actually queried. Without it the test passes on a mocked
    // `findMany` that returns the member whatever the bound is — which is
    // exactly how the narrowed bound shipped unnoticed the first time.
    const queried = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    expect(queried.lte).toBeUndefined();
    expect(member.dateOfBirth.getTime()).toBeLessThan(
      (queried.lt as Date).getTime(),
    );
  });

  it("does not promote a member born the day AFTER the cutoff day", async () => {
    const member = {
      id: "m-boundary-off",
      email: "dayafter@example.com",
      firstName: "Cai",
      lastName: "Dayafter",
      // One day later: they turn 18 on 2 April 2026, the day after season
      // start, so they are still YOUTH for this season.
      dateOfBirth: new Date("2008-04-02T00:00:00.000Z"),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    // Deliberately handed to the job as a CANDIDATE. Widening the SQL bound to
    // the whole cutoff day is what lets this row through the prefilter, so the
    // assertion below is the half of the argument the widening depends on:
    // `computeAgeTierWithSettings` is a real authority that re-checks every
    // candidate, not a formality. If it were not, widening would promote people
    // a year early.
    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);

    // BOTH SIDES OF GREENWICH, and the second one is the discriminating half:
    // this member is the single day of birthdays the retired host-local read
    // misclassified, and `America/Denver` is where it did it. Before #3082 the
    // Denver run promoted them HERE — ADULT, their own login, and a different
    // price band, a season early.
    //
    // TRUE OF THIS TEST, AND NOT OF PRODUCTION, which matters because the
    // difference has already been published once as a defect that never existed.
    // This suite mocks `prisma.member.findMany`, so it hands the job a candidate
    // the real prefilter would never have proposed:
    // `dateOfBirthPrefilterBoundForMinAge` is EXCLUSIVE at
    // `seasonStart - minAge years` plus one day, and this member is born the day
    // after that, so a live Denver run never saw them. Swept in
    // `policies/age-tier.ts`'s module docblock: 27 638 160 admitted candidates
    // across 418 zones, zero verdict changes. What this test pins is the
    // AUTHORITY itself, on the exact input the bypassed bound would have
    // filtered — which is the only place that half of the argument can be stated.
    for (const hostZone of ["Pacific/Auckland", "America/Denver"]) {
      mockedUpdate.mockClear();
      mockedSendEmail.mockClear();

      const result = await withTimeZoneAsync(hostZone, () =>
        checkAgeUpMembers(),
      );

      expect(result.upgraded, hostZone).toBe(0);
      expect(result.skipped, hostZone).toBe(1);
      expect(mockedUpdate, hostZone).not.toHaveBeenCalled();
      expect(mockedSendEmail, hostZone).not.toHaveBeenCalled();
    }
  });

  it("should use the configured ADULT age tier for cutoff and email data", async () => {
    mockedAgeTierSettingsFindMany.mockResolvedValue([
      {
        tier: "CHILD",
        minAge: 0,
        maxAge: 12,
        label: "Junior",
        sortOrder: 1,
        subscriptionRequiredForBooking: false,
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "YOUTH",
        minAge: 13,
        maxAge: 20,
        label: "Youth",
        sortOrder: 2,
        subscriptionRequiredForBooking: true,
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "ADULT",
        minAge: 21,
        maxAge: null,
        label: "Senior (21+)",
        sortOrder: 3,
        subscriptionRequiredForBooking: true,
        xeroAcceptedContactGroups: [],
      },
    ] as any);

    const member = {
      id: "m-adult-21",
      email: "adult21@example.com",
      firstName: "Alex",
      lastName: "Boundary",
      dateOfBirth: dobForAge(21),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(EMAIL_SENT);

    // Zone forced for the same reason as the criteria test above (#2872): on a
    // UTC runner a local-midnight bound and a calendar-day bound are the same
    // instant, and the cutoff assertions below would not discriminate.
    const result = await withTimeZoneAsync("Pacific/Auckland", () =>
      checkAgeUpMembers(),
    );

    expect(result.upgraded).toBe(1);
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    // #2859: exclusive bound on the day after the configured cutoff day. With
    // an ADULT minimum age of 21 the cutoff day is 1 April 2005, so the window
    // ends at the start of 2 April 2005.
    const cutoffWindowEnd = cutoff.lt as Date;
    // UTC getters (#2872): the bound is a calendar day at UTC midnight now that
    // `Member.dateOfBirth` is `@db.Date`.
    expect(cutoffWindowEnd.getUTCFullYear()).toBe(2005);
    expect(cutoffWindowEnd.getUTCMonth()).toBe(3);
    expect(cutoffWindowEnd.getUTCDate()).toBe(2);
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "adult21@example.com",
      "Alex",
      expect.any(String),
      {
        targetAgeTier: "ADULT",
        targetAgeTierLabel: "Senior (21+)",
        targetAgeTierMinAge: 21,
      }
    );
  });
});

describe("ageUpInvitationTemplate", () => {
  it("should generate HTML with member name and reset URL", async () => {
    const { ageUpInvitationTemplate } = await import("@/lib/email-templates/membership");

    const html = ageUpInvitationTemplate("Alice", "https://example.com/reset?token=abc");

    expect(html).toContain("Alice");
    expect(html).toContain("https://example.com/reset?token=abc");
    expect(html).toContain("Adult (18+)");
    expect(html).toContain("Set Up My Password");
  });

  it("should use the configured target age tier label", async () => {
    const { ageUpInvitationTemplate } = await import("@/lib/email-templates/membership");

    const html = ageUpInvitationTemplate(
      "Alice",
      "https://example.com/reset?token=abc",
      { targetAgeTierLabel: "Senior (21+)" }
    );

    expect(html).toContain("Senior (21+)");
    expect(html).not.toContain("turned 18");
  });

  it("should escape HTML in firstName", async () => {
    const { ageUpInvitationTemplate } = await import("@/lib/email-templates/membership");

    const html = ageUpInvitationTemplate("<script>alert('xss')</script>", "https://example.com");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("ageUpParentEmailHandoffTemplate", () => {
  it("generates a tokenless handoff message and escapes member data", async () => {
    const { ageUpParentEmailHandoffTemplate } = await import("@/lib/email-templates/membership");

    const html = ageUpParentEmailHandoffTemplate({
      recipientName: "Pat Parent",
      memberFirstName: "<Charlie>",
      memberLastName: "Brown",
      targetAgeTierLabel: "Adult (18+)",
    });

    expect(html).toContain("Pat Parent");
    expect(html).toContain("&lt;Charlie&gt; Brown");
    expect(html).toContain("unique email address");
    expect(html).not.toContain("token=");
    expect(html).not.toContain("Set Up My Password");
  });
});

describe("sendAgeUpInvitationEmail", () => {
  it("should be importable and callable", async () => {
    // Verify the function exists and accepts the right params
    expect(typeof sendAgeUpInvitationEmail).toBe("function");
  });
});

// --- #3035 (ENV-SAFETY 2): a withheld invitation must not leave a stranded adult
//
// THE SHAPE OF THE DEFECT. By the time this cron calls the mailer it has already
// committed the tier flip, granted `canLogin`, cleared the member's inherited
// mailbox and minted a single-use invitation token. `sendEmail` RETURNS rather
// than throws when it withholds, so the `catch`-block rollback never fired and
// `upgradeResult = null` disarmed it unconditionally.
//
// And the harm is PERMANENT, not merely a missed run: the `alreadySent` guard
// only matches SENT/QUEUED EmailLog rows so it does not block a retry, but the
// transaction's own re-check sees `canLogin: true` and `ageTier: "ADULT"` and
// returns null — so every later run counts the member as skipped. They have a
// login they were never told about, and the reset token expires in a week.
describe("checkAgeUpMembers environment-safety withholds (#3035)", () => {
  function agingYouth() {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1",
        email: "youth@example.com",
        firstName: "Alice",
        lastName: "Smith",
        dateOfBirth: dobForAge(18),
        inheritEmailFromId: null,
        inheritEmailFrom: null,
      },
    ] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
  }

  /** The compensating age-DOWN write, if the cron made one. */
  function rollbackWrite() {
    return mockTxMemberUpdateMany.mock.calls.find(
      (call) =>
        (call[0] as { data?: { canLogin?: unknown } }).data?.canLogin === false,
    );
  }

  it("rolls the upgrade back when the installation's role is unknown", async () => {
    agingYouth();
    mockedSendEmail.mockResolvedValue(
      emailWithheldForEnvironment("environment_unknown"),
    );

    const result = await checkAgeUpMembers();

    expect(rollbackWrite()?.[0]).toEqual(
      expect.objectContaining({
        where: { id: "m1", canLogin: true, ageTier: "ADULT" },
        data: expect.objectContaining({ canLogin: false, ageTier: "YOUTH" }),
      }),
    );
    // The minted invitation token goes with it — an unusable password-reset token
    // must not sit in the table for a week.
    expect(mockTxTokenDeleteMany).toHaveBeenCalled();
    expect(result.upgraded).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("rolls the upgrade back when the live site declares a capture mailbox", async () => {
    agingYouth();
    mockedSendEmail.mockResolvedValue(
      emailWithheldForEnvironment("capture_transport_in_production"),
    );

    const result = await checkAgeUpMembers();

    expect(rollbackWrite()).toBeDefined();
    expect(result.failed).toBe(1);
  });

  it("KEEPS the upgrade on a confirmed copy, so a copy does not age one member up and down forever", async () => {
    /*
      Terminal rather than a fault: a copy is a copy until somebody re-declares
      it. Rolling back there would have a staging box flip the same member up and
      down on every run, writing a new counted SKIPPED_NON_PRODUCTION row each
      pass — the number that tells a live club wrongly declared a copy from an
      idle one (owner decision 1, 23 Aug 2026).
    */
    agingYouth();
    mockedSendEmail.mockResolvedValue(
      emailWithheldForEnvironment("environment_non_production"),
    );

    const result = await checkAgeUpMembers();

    expect(rollbackWrite()).toBeUndefined();
    expect(result.upgraded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("does not write the handoff audit row when the handoff email was withheld", async () => {
    /*
      The audit row is the ONLY thing that stops the handoff being attempted
      again — `hasAgeUpParentEmailHandoffAudit` reads it — so writing it for a
      message that never went out closes the door on ever asking the parent for
      this member's own address.
    */
    mockedFindMany.mockResolvedValue([
      {
        id: "m1",
        email: "shared@example.com",
        firstName: "Alice",
        lastName: "Smith",
        dateOfBirth: dobForAge(18),
        inheritEmailFromId: "p1",
        inheritEmailFrom: {
          id: "p1",
          email: "shared@example.com",
          firstName: "Pat",
          lastName: "Smith",
        },
      },
    ] as any);
    mockedAuditLogFind.mockResolvedValue(null);
    mockedSendHandoffEmail.mockResolvedValue(
      emailWithheldForEnvironment("environment_unknown"),
    );

    const result = await checkAgeUpMembers();

    expect(mockedAuditLogCreate).not.toHaveBeenCalled();
    expect(result.handoff).toBe(0);
    expect(result.failed).toBe(1);
    // No login was granted either: the handoff branch returns before the upgrade.
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("DOES write the handoff audit row on a confirmed copy, so a copy stops re-attempting it", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1",
        email: "shared@example.com",
        firstName: "Alice",
        lastName: "Smith",
        dateOfBirth: dobForAge(18),
        inheritEmailFromId: "p1",
        inheritEmailFrom: {
          id: "p1",
          email: "shared@example.com",
          firstName: "Pat",
          lastName: "Smith",
        },
      },
    ] as any);
    mockedAuditLogFind.mockResolvedValue(null);
    mockedSendHandoffEmail.mockResolvedValue(
      emailWithheldForEnvironment("environment_non_production"),
    );

    await checkAgeUpMembers();

    expect(mockedAuditLogCreate).toHaveBeenCalled();
  });
});
