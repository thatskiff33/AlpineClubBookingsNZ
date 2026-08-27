import { beforeEach, describe, expect, it, vi } from "vitest";

// E10 (#1936): approveMemberApplication mapping paths — promotion vs keep-auth,
// joining-fee SKIP default, token drift + concurrent-approval serialization,
// skip-with-note billing exclusion, collision BLOCK enforcement, and family MAP.

const { prismaMock, emailMock, xeroMock, xeroOutboxMock, billingMock, auditMock } =
  vi.hoisted(() => ({
    prismaMock: {
      member: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      memberApplication: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    },
    emailMock: {
      sendMembershipApplicationApprovedEmail: vi.fn().mockResolvedValue(undefined),
      sendMembershipApplicationRejectedEmail: vi.fn().mockResolvedValue(undefined),
      sendInductionSignOffRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendNominationRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendAdminMembershipApplicationPendingEmail: vi.fn().mockResolvedValue(undefined),
    },
    xeroMock: {
      isXeroConnected: vi.fn().mockResolvedValue(false),
      findOrCreateXeroContact: vi.fn().mockResolvedValue("xc-1"),
    },
    xeroOutboxMock: {
      enqueueXeroEntranceFeeInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: "q1", message: "queued" }),
      processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({ processed: 1 }),
    },
    billingMock: {
      queueApprovedMembershipSubscriptionCharges: vi.fn().mockResolvedValue({ chargeIds: [], exceptionCount: 0 }),
    },
    auditMock: { logAudit: vi.fn() },
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01T00:00:00.000Z")),
}));
vi.mock("@/lib/email", () => emailMock);
vi.mock("@/lib/xero", () => xeroMock);
vi.mock("@/lib/xero-operation-outbox", () => xeroOutboxMock);
vi.mock("@/lib/membership-subscription-billing", () => billingMock);
vi.mock("@/lib/audit", () => auditMock);
vi.mock("@/lib/induction", () => ({ createMemberInduction: vi.fn() }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ induction: false }),
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("fresh-hash") }));

import { approveMemberApplication } from "@/lib/nomination";
import { buildApprovalMappingPreview } from "@/lib/member-application-mapping";

const APPLICANT_MAP = {
  applicant: { mode: "MAP" as const, memberId: "member-x" },
  family: [] as Array<{ mode: "CREATE" } | { mode: "MAP"; memberId: string }>,
};

function applicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantEmail: "jane@test.com",
    applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    applicantPhone: "64 21 5551234",
    applicantAddress: null,
    familyMembers: [],
    nominator1Email: "n1@test.com",
    nominator2Email: "n2@test.com",
    nominator1Id: "nom-1",
    nominator2Id: "nom-2",
    nominator1ConfirmedAt: new Date("2026-04-11T00:00:00.000Z"),
    nominator2ConfirmedAt: new Date("2026-04-11T00:00:00.000Z"),
    status: "PENDING_ADMIN",
    adminNotes: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-x",
    email: "old@test.com",
    firstName: "Old",
    lastName: "Name",
    dateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    ageTier: "ADULT",
    role: "USER",
    active: true,
    archivedAt: null,
    canLogin: false,
    parentMemberId: null,
    inheritParentEmail: false,
    inheritEmailFromId: null,
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    streetAddressLine1: null,
    streetAddressLine2: null,
    streetCity: null,
    streetRegion: null,
    streetPostalCode: null,
    streetCountry: null,
    postalAddressLine1: null,
    postalAddressLine2: null,
    postalCity: null,
    postalRegion: null,
    postalPostalCode: null,
    postalCountry: null,
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
    xeroContactId: null,
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    familyGroupMemberships: [],
    subscriptions: [],
    seasonalMembershipAssignments: [],
    financeAccessLevel: null,
    accessRoles: [],
    ...overrides,
  };
}

// Acting admins for the #1026 privileged-email gate. The in-tx recompute
// re-reads the PUT actor's roles via tx.member.findUnique.
const FULL_ADMIN_ROW = {
  id: "admin-1",
  canLogin: true,
  accessRoles: [{ role: "ADMIN", roleDefinitionId: null }],
};
const SCOPED_ADMIN_ROW = {
  id: "admin-1",
  canLogin: true,
  accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinitionId: null }],
};

// A member.findMany that returns targets for id-in queries and [] for the
// suggestions query (archivedAt filter).
function findManyFor(targets: Array<Record<string, unknown>>) {
  return vi.fn(async (args: { where?: { id?: { in?: string[] } } }) => {
    if (args?.where?.id?.in) {
      const wanted = args.where.id.in;
      const byId = new Map(targets.map((row) => [row.id as string, row]));
      // #2255: the family-link depth walk reads "these ids", and is asked about
      // the APPLICANT, who is created in this transaction and is not one of the
      // mapping targets. Returning nothing for them made the applicant look
      // like a member with no email at all, and the approval 422'd on "nothing
      // to inherit". Anyone not in `targets` is therefore modelled as what the
      // applicant is: an ordinary parentless adult with a real address.
      //
      // #2716: the email resolver no longer reads this at all — it reads the
      // chosen parent's single row through `findUnique` (see `makeTx`). This
      // stub now serves only the four-generation LINK depth walk, which the
      // one-hop decision left untouched.
      return wanted.map(
        (id) =>
          byId.get(id) ?? {
            id,
            email: "jane@test.com",
            ageTier: "ADULT",
            archivedAt: null,
            inheritEmailFromId: null,
            parentMemberId: null,
            secondaryParentId: null,
          },
      );
    }
    return [];
  });
}

function makeTx(overrides: {
  targets: Array<Record<string, unknown>>;
  loginHolder?: { id: string } | null;
  updateResult?: Record<string, unknown>;
  // The acting admin row the in-tx #1026 gate re-reads. Defaults to a Full
  // Admin so pre-existing scenarios are unaffected.
  actingAdmin?: Record<string, unknown> | null;
}) {
  const update = vi.fn().mockResolvedValue(
    overrides.updateResult ?? {
      id: "member-x",
      email: "jane@test.com",
      firstName: "Jane",
      lastName: "Doe",
    },
  );
  return {
    tx: {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      member: {
        findMany: findManyFor(overrides.targets),
        findFirst: vi.fn().mockResolvedValue(overrides.loginHolder ?? null),
        // Routed by id, not a single blanket row: the #1026 gate re-reads the
        // ACTING ADMIN here, and #2255 added a second reader —
        // `validateInheritEmailSource` reads the resolved email SOURCE back
        // before it is stored. Answering both with the admin row made the
        // source look like a member with no age tier and failed the approval on
        // "must point to an adult member".
        //
        // #2716 made this the reader that DECIDES the mailbox as well: with the
        // walk up the family retired, `resolveInheritedEmailSourceId` reads the
        // chosen parent here and asks `isUsableEmailSource`, which now also
        // requires `inheritEmailChoiceId` to be NULL — a member who has CHOSEN
        // to inherit is never a mailbox, even while their own pointer is NULL.
        // Omitting the column left it `undefined`, which is not `null`, so the
        // applicant read as an inheritor and the approval 422'd.
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === "admin-1") {
            return overrides.actingAdmin === undefined
              ? FULL_ADMIN_ROW
              : overrides.actingAdmin;
          }
          return {
            id: where.id,
            email: "jane@test.com",
            ageTier: "ADULT",
            archivedAt: null,
            inheritEmailFromId: null,
            inheritEmailChoiceId: null,
          };
        }),
        create: vi.fn().mockResolvedValue({ id: "member-1", email: "jane@test.com", firstName: "Jane", lastName: "Doe" }),
        update,
      },
      familyGroup: { create: vi.fn().mockResolvedValue({ id: "fg-1" }) },
      familyGroupMember: { create: vi.fn(), upsert: vi.fn() },
      passwordResetToken: { deleteMany: vi.fn(), create: vi.fn() },
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue(applicationRow()),
        update: vi.fn().mockResolvedValue(applicationRow({ status: "APPROVED" })),
      },
    },
    update,
  };
}

async function tokenFor(
  personDecisions: unknown,
  targets: Array<Record<string, unknown>>,
  loginHolder: { id: string } | null = null,
  actor: { id: string; isFullAdmin: boolean } = { id: "admin-1", isFullAdmin: true },
) {
  prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
  prismaMock.member.findMany.mockImplementation(findManyFor(targets));
  prismaMock.member.findFirst.mockResolvedValue(loginHolder as never);
  const result = await buildApprovalMappingPreview({
    applicationId: "app-1",
    personDecisions: personDecisions as never,
    seasonYear: 2026,
    actor,
  });
  return (result.body as { preview: { previewToken: string } }).preview.previewToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  xeroMock.isXeroConnected.mockResolvedValue(false);
  billingMock.queueApprovedMembershipSubscriptionCharges.mockResolvedValue({ chargeIds: [], exceptionCount: 0 });
  // Post-approval warning persistence path chains `.update(...).catch(...)`.
  prismaMock.memberApplication.update.mockResolvedValue({} as never);
});

describe("applicant MAP — promotion path (canLogin:false -> true)", () => {
  it("promotes auth, clears inheritance, defaults the joining fee to SKIP, and audits the mapping", async () => {
    const targets = [targetRow({ canLogin: false })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      canLogin: true,
      passwordHash: "fresh-hash",
      emailVerified: true,
      inheritEmailFromId: null,
      inheritParentEmail: false,
      email: "jane@test.com",
      profileCompletedAt: expect.any(Date),
      detailsConfirmedAt: expect.any(Date),
      onboardingConfirmedAt: expect.any(Date),
    });
    expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(1);
    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).toHaveBeenCalledTimes(1);
    expect(result.mappedMemberIds).toEqual(["member-x"]);
    expect(result.createdMemberIds).toEqual([]);
    expect(auditMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_APPLICATION_MAPPED_TO_EXISTING", severity: "critical" }),
    );
    expect(billingMock.queueApprovedMembershipSubscriptionCharges).toHaveBeenCalledWith({
      memberIds: ["member-x"],
      approvedByMemberId: "admin-1",
    });
  });
});

describe("applicant MAP — keep-auth path (existing login target)", () => {
  it("never touches auth fields, issues no setup token, and sends no set-password email", async () => {
    const targets = [targetRow({ canLogin: true, email: "jane@test.com" })];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "member-x" });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: { id: "member-x" } });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    const data = update.mock.calls[0][0].data;
    expect(data.passwordHash).toBeUndefined();
    expect(data.canLogin).toBeUndefined();
    expect(data.emailVerified).toBeUndefined();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).not.toHaveBeenCalled();
    expect(result.warnings).toContain(
      "Applicant mapped to an existing login member; no account-setup email was sent.",
    );
  });

  it("does not regress confirmation timestamps that are already set", async () => {
    const already = new Date("2020-01-01T00:00:00.000Z");
    const targets = [targetRow({
      canLogin: true,
      email: "jane@test.com",
      profileCompletedAt: already,
      detailsConfirmedAt: already,
      detailsConfirmedByMemberId: "member-x",
      onboardingConfirmedAt: already,
    })];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "member-x" });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: { id: "member-x" } });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token);

    const data = update.mock.calls[0][0].data;
    expect(data.profileCompletedAt).toBeUndefined();
    expect(data.detailsConfirmedAt).toBeUndefined();
    expect(data.detailsConfirmedByMemberId).toBeUndefined();
    expect(data.onboardingConfirmedAt).toBeUndefined();
  });
});

describe("token drift + concurrent-approval serialization", () => {
  it("409s a stale/forged token", async () => {
    const targets = [targetRow()];
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, "not-a-valid-token"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("409s when the locked target's updatedAt advanced since the preview (serialization) with ZERO side effects", async () => {
    const previewTargets = [targetRow({ updatedAt: new Date("2026-04-10T00:00:00.000Z") })];
    const token = await tokenFor(APPLICANT_MAP, previewTargets, null);

    // The concurrent winner advanced the row: the in-tx reload returns a later
    // updatedAt, so the recomputed token no longer matches.
    const reloadedTargets = [targetRow({ updatedAt: new Date("2026-04-13T00:00:00.000Z") })];
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets: reloadedTargets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    // Explicitly try to raise the fee too: the drift 409 must fire first.
    await expect(
      approveMemberApplication(
        "app-1", "admin-1", null, { action: "CREATE" }, undefined, APPLICANT_MAP, token,
      ),
    ).rejects.toMatchObject({ status: 409 });
    // The application status was never flipped to APPROVED, and NO side
    // effects escaped: no member write, no setup token, no fee enqueue, no
    // audit, no billing, no email.
    expect(tx.memberApplication.update).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(tx.member.create).not.toHaveBeenCalled();
    expect(tx.passwordResetToken.deleteMany).not.toHaveBeenCalled();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(tx.familyGroup.create).not.toHaveBeenCalled();
    expect(tx.familyGroupMember.create).not.toHaveBeenCalled();
    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
    expect(xeroOutboxMock.processQueuedXeroOutboxOperations).not.toHaveBeenCalled();
    expect(auditMock.logAudit).not.toHaveBeenCalled();
    expect(billingMock.queueApprovedMembershipSubscriptionCharges).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).not.toHaveBeenCalled();
    expect(emailMock.sendInductionSignOffRequestEmail).not.toHaveBeenCalled();
    // No post-approval warning persistence either.
    expect(prismaMock.memberApplication.update).not.toHaveBeenCalled();
  });

  it("400s a MAP decision submitted without a preview token, before any transaction", async () => {
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, null),
    ).rejects.toMatchObject({ status: 400 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("collision BLOCKs enforced at the approve layer (valid token, still refused)", () => {
  it("blocks mapping onto a nominator of this application", async () => {
    const targets = [targetRow({ id: "nom-1" })];
    const decisions = { applicant: { mode: "MAP" as const, memberId: "nom-1" }, family: [] };
    const token = await tokenFor(decisions, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, decisions, token),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("nominator") });
    expect(update).not.toHaveBeenCalled();
    expect(tx.memberApplication.update).not.toHaveBeenCalled();
  });

  it("blocks two persons mapped onto the same member (duplicate target)", async () => {
    const familyApp = applicationRow({
      familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
    });
    const decisions = {
      applicant: { mode: "MAP" as const, memberId: "member-x" },
      family: [{ mode: "MAP" as const, memberId: "member-x" }],
    };
    const targets = [targetRow()];
    prismaMock.memberApplication.findUnique.mockResolvedValue(familyApp as never);
    prismaMock.member.findMany.mockImplementation(findManyFor(targets));
    prismaMock.member.findFirst.mockResolvedValue(null as never);
    const previewResult = await buildApprovalMappingPreview({
      applicationId: "app-1",
      personDecisions: decisions as never,
      seasonYear: 2026,
      actor: { id: "admin-1", isFullAdmin: true },
    });
    const token = (previewResult.body as { preview: { previewToken: string } }).preview.previewToken;

    prismaMock.memberApplication.findUnique.mockResolvedValue(familyApp as never);
    const { tx, update } = makeTx({ targets, loginHolder: null });
    tx.memberApplication.findUnique.mockResolvedValue(familyApp);
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, decisions, token),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("cannot be mapped to more than one person"),
    });
    expect(update).not.toHaveBeenCalled();
    expect(tx.member.create).not.toHaveBeenCalled();
  });

  it("blocks mapping when a DIFFERENT member holds a login for the application email", async () => {
    const targets = [targetRow()];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "someone-else" });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: { id: "someone-else" } });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
    expect(tx.memberApplication.update).not.toHaveBeenCalled();
  });
});

describe("explicit fee CREATE for a mapped applicant", () => {
  it("enqueues the entrance fee in-tx against the TARGET member id", async () => {
    const targets = [targetRow({ canLogin: true, email: "jane@test.com" })];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "member-x" });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: { id: "member-x" } });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await approveMemberApplication(
      "app-1", "admin-1", null, { action: "CREATE" }, undefined, APPLICANT_MAP, token,
    );

    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledTimes(1);
    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledWith(
      "member-x",
      expect.objectContaining({ createdByMemberId: "admin-1", store: tx }),
    );
  });
});

describe("privileged-email gate at the approve layer (#1026 parity)", () => {
  const privilegedTargets = () => [
    targetRow({
      canLogin: true,
      email: "officer@test.com",
      accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinitionId: null }],
    }),
  ];

  it("blocks a scoped admin whose own preview carries the blocking error", async () => {
    const targets = privilegedTargets();
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-1",
      isFullAdmin: false,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    // Token matches (same actor previewed), but the blocking error refuses it.
    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Only a Full Admin can change a privileged member's email"),
    });
    expect(update).not.toHaveBeenCalled();
    expect(tx.memberApplication.update).not.toHaveBeenCalled();
  });

  it("fails CLOSED when a Full Admin's preview token is replayed by a scoped-admin PUT (409 token drift, zero side effects)", async () => {
    const targets = privilegedTargets();
    // Preview minted by a Full Admin: no blocking error in the payload.
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-9",
      isFullAdmin: true,
    });

    // The PUT actor re-read in-tx is a scoped admin: the recompute adds the
    // blocking error, the outcome payload diverges, and the token mismatches.
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication(
        "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed since it was previewed"),
    });
    expect(update).not.toHaveBeenCalled();
    expect(tx.member.create).not.toHaveBeenCalled();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
    expect(auditMock.logAudit).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).not.toHaveBeenCalled();
  });

  it("allows a Full Admin to approve the same privileged-email mapping", async () => {
    const targets = privilegedTargets();
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-1",
      isFullAdmin: true,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: FULL_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    expect(result.mappedMemberIds).toEqual(["member-x"]);
    const data = update.mock.calls[0][0].data;
    expect(data.email).toBe("jane@test.com");
    // Keep-auth invariant holds even under the Full-Admin overwrite.
    expect(data.passwordHash).toBeUndefined();
    expect(data.canLogin).toBeUndefined();
    expect(data.emailVerified).toBeUndefined();
  });

  it("leaves a same-email mapping by a scoped admin unaffected", async () => {
    const targets = [
      targetRow({
        canLogin: true,
        email: "jane@test.com",
        accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinitionId: null }],
      }),
    ];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "member-x" }, {
      id: "admin-1",
      isFullAdmin: false,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({
      targets,
      loginHolder: { id: "member-x" },
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );
    expect(result.mappedMemberIds).toEqual(["member-x"]);
  });
});

describe("privileged promotion gate at the approve layer (#1604 parity)", () => {
  // A cancelled ex-admin: canLogin already false, access-role row dormantly
  // stored. Invisible to the canLogin-aware email gate — only the
  // canLogin-BLIND promotion gate sees it.
  const dormantTargets = (overrides: Record<string, unknown> = {}) => [
    targetRow({
      canLogin: false,
      email: "dormant@test.com",
      accessRoles: [{ role: "ADMIN", roleDefinitionId: null }],
      ...overrides,
    }),
  ];

  function expectZeroSideEffects(tx: ReturnType<typeof makeTx>["tx"], update: ReturnType<typeof vi.fn>) {
    expect(update).not.toHaveBeenCalled();
    expect(tx.member.create).not.toHaveBeenCalled();
    expect(tx.passwordResetToken.deleteMany).not.toHaveBeenCalled();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(tx.memberApplication.update).not.toHaveBeenCalled();
    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
    expect(auditMock.logAudit).not.toHaveBeenCalled();
    expect(billingMock.queueApprovedMembershipSubscriptionCharges).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).not.toHaveBeenCalled();
  }

  it("blocks a scoped admin promoting a dormant ex-ADMIN, with ZERO side effects", async () => {
    const targets = dormantTargets();
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-1",
      isFullAdmin: false,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    // Token matches (same scoped actor previewed), but the blocking error
    // refuses the approval before any write.
    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "Only a Full Admin can activate login on a member who holds a privileged role",
      ),
    });
    expectZeroSideEffects(tx, update);
  });

  it("blocks a scoped admin promoting a legacy dormant Treasurer (financeAccessLevel, no access-role rows)", async () => {
    const targets = dormantTargets({ accessRoles: [], financeAccessLevel: "MANAGER" });
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-1",
      isFullAdmin: false,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "Only a Full Admin can activate login on a member who holds a privileged role",
      ),
    });
    expectZeroSideEffects(tx, update);
  });

  it("fails CLOSED when a Full-Admin preview token is replayed by a scoped-admin PUT (409 token drift, zero side effects)", async () => {
    const targets = dormantTargets();
    // Preview minted by a Full Admin: no blocking error in the payload.
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-9",
      isFullAdmin: true,
    });

    // The PUT actor re-read in-tx is a scoped admin: the recompute adds the
    // promotion blocking error, the payload diverges, the token mismatches.
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed since it was previewed"),
    });
    expectZeroSideEffects(tx, update);
  });

  it("allows a Full Admin to promote the same dormant-privileged target", async () => {
    const targets = dormantTargets();
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-1",
      isFullAdmin: true,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: FULL_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    expect(result.mappedMemberIds).toEqual(["member-x"]);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      canLogin: true,
      emailVerified: true,
      email: "jane@test.com",
    });
    expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-privileged promotion by a scoped admin ungated (no false positive)", async () => {
    const targets = [targetRow({ canLogin: false })]; // plain USER, no roles
    const token = await tokenFor(APPLICANT_MAP, targets, null, {
      id: "admin-1",
      isFullAdmin: false,
    });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({
      targets,
      loginHolder: null,
      actingAdmin: SCOPED_ADMIN_ROW,
    });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    expect(result.mappedMemberIds).toEqual(["member-x"]);
    const data = update.mock.calls[0][0].data;
    expect(data.canLogin).toBe(true);
  });
});

describe("post-approval warnings for kept season coverage", () => {
  it("pushes a per-target warning when the seasonal-coverage skip kept existing coverage", async () => {
    const targets = [targetRow({ subscriptions: [{ id: "sub-1" }] })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Jane Doe was mapped to an existing member who already has this season's membership coverage"),
      ]),
    );
  });
});

describe("collision + billing policy at approval", () => {
  it("blocks a mapping onto an inactive/archived target even with a valid token", async () => {
    const targets = [targetRow({ active: false })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("excludes a skip-with-note target (existing coverage) from subscription billing", async () => {
    const targets = [targetRow({ subscriptions: [{ id: "sub-1" }] })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token);

    expect(billingMock.queueApprovedMembershipSubscriptionCharges).toHaveBeenCalledWith({
      memberIds: [],
      approvedByMemberId: "admin-1",
    });
  });
});

describe("family MAP", () => {
  const familyApp = () =>
    applicationRow({
      familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
    });
  const familyDecisions = {
    applicant: { mode: "CREATE" as const },
    family: [{ mode: "MAP" as const, memberId: "child-x" }],
  };

  it("creates the applicant, overwrites + re-parents the mapped dependent, and joins the group", async () => {
    const childTarget = targetRow({ id: "child-x", canLogin: false, parentMemberId: null });
    // Preview against the family application.
    prismaMock.memberApplication.findUnique.mockResolvedValue(familyApp() as never);
    prismaMock.member.findMany.mockImplementation(findManyFor([childTarget]));
    prismaMock.member.findFirst.mockResolvedValue(null as never);
    const previewResult = await buildApprovalMappingPreview({
      applicationId: "app-1",
      personDecisions: familyDecisions as never,
      seasonYear: 2026,
      actor: { id: "admin-1", isFullAdmin: true },
    });
    const token = (previewResult.body as { preview: { previewToken: string } }).preview.previewToken;

    prismaMock.memberApplication.findUnique.mockResolvedValue(familyApp() as never);
    const { tx, update } = makeTx({ targets: [childTarget], loginHolder: null });
    tx.memberApplication.findUnique.mockResolvedValue(familyApp());
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, familyDecisions, token,
    );

    // Applicant created; dependent updated (re-parented) not created.
    expect(tx.member.create).toHaveBeenCalledTimes(1);
    const depUpdate = update.mock.calls.find((call) => call[0].where.id === "child-x");
    expect(depUpdate?.[0].data).toMatchObject({
      parentMemberId: "member-1",
      inheritParentEmail: true,
      inheritEmailFromId: "member-1",
      // #2716: the mapping writer records WHO WAS CHOSEN beside the mailbox the
      // choice resolves to. One hop means both name the newly created
      // applicant — the dependant's direct parent — and never anyone further up.
      inheritEmailChoiceId: "member-1",
    });
    expect(tx.familyGroupMember.upsert).toHaveBeenCalled();
    expect(result.createdMemberIds).toEqual(["member-1"]);
    expect(result.mappedMemberIds).toEqual(["child-x"]);
  });
});
