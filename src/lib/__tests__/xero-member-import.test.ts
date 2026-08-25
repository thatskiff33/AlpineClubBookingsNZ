import { beforeEach, describe, expect, it, vi } from "vitest";

// #2108: focused unit coverage for the membership-type import behaviour added on
// top of the age-tier import. Mocks the direct dependencies of
// xero-member-import so the mode matrix, never-overwrite, gating-adjacent
// resolution, 422 validation, IMPORT source, summary audit and dedupe can be
// asserted in isolation.

const mocks = vi.hoisted(() => ({
  prisma: {
    membershipType: { findMany: vi.fn() },
    xeroContactGroupMembershipCache: { findMany: vi.fn() },
    xeroContactCache: { findMany: vi.fn() },
    member: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn(), createMany: vi.fn() },
    familyGroup: { create: vi.fn() },
    familyGroupMember: { findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn() },
    passwordResetToken: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  sendPasswordResetEmail: vi.fn(),
  issueActionToken: vi.fn(() => ({ token: "tok", tokenHash: "hash" })),
  computeAgeTier: vi.fn(async () => "YOUTH"),
  buildStructuredAuditLogCreateArgs: vi.fn((event: unknown) => ({ data: event })),
  getXeroSyncCursor: vi.fn(async () => ({ lastSuccessfulSyncAt: new Date("2026-04-01T00:00:00Z") })),
  parseXeroContactDateOfBirth: vi.fn((): Date | null => null),
  getSeasonalMembershipChangePreview: vi.fn(),
  saveSeasonalMembershipAssignment: vi.fn(),
  reconcileMembersXeroContactGroups: vi.fn(async () => ({
    processed: 1,
    haltedByDailyLimit: false,
  })),
  upsertXeroObjectLink: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email", () => ({ sendPasswordResetEmail: mocks.sendPasswordResetEmail }));
vi.mock("@/lib/action-tokens", () => ({ issueActionToken: mocks.issueActionToken }));
vi.mock("@/lib/age-tier", () => ({ computeAgeTier: mocks.computeAgeTier }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(),
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
}));
vi.mock("@/lib/xero-contact-cache", () => ({
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE: "CONTACT_GROUP_CACHE",
  fetchXeroContactsByIdsFromXero: vi.fn(),
  getXeroContactDisplayName: (c: { name?: string }) => c.name ?? "Unknown",
  upsertXeroContactCacheEntry: vi.fn(),
}));
vi.mock("@/lib/xero-contact-date-of-birth", () => ({
  parseXeroContactDateOfBirth: mocks.parseXeroContactDateOfBirth,
}));
vi.mock("@/lib/xero-sync-cursors", () => ({
  DEFAULT_XERO_SYNC_SCOPE: "default",
  getXeroSyncCursor: mocks.getXeroSyncCursor,
  parseXeroError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/seasonal-membership-assignments", () => ({
  getSeasonalMembershipChangePreview: mocks.getSeasonalMembershipChangePreview,
  saveSeasonalMembershipAssignment: mocks.saveSeasonalMembershipAssignment,
}));
vi.mock("@/lib/xero-contact-groups", () => ({
  reconcileMembersXeroContactGroups: mocks.reconcileMembersXeroContactGroups,
}));
vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn(async () => "placeholder-hash") }));

import {
  importMembersFromXeroGroups,
  XeroMemberImportValidationError,
  XERO_MEMBER_IMPORT_MEMBERSHIP_TYPES_ACTION,
} from "@/lib/xero-member-import";

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    contactId: "contact_1",
    name: "New Person",
    firstName: "New",
    lastName: "Person",
    emailAddress: "new@example.com",
    companyNumber: null,
    contactStatus: "ACTIVE",
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
    ...overrides,
  };
}

const ADMIN_ID = "admin_1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.computeAgeTier.mockResolvedValue("YOUTH");
  mocks.parseXeroContactDateOfBirth.mockReturnValue(null);
  mocks.getXeroSyncCursor.mockResolvedValue({
    lastSuccessfulSyncAt: new Date("2026-04-01T00:00:00Z"),
  });
  mocks.prisma.member.findFirst.mockResolvedValue(null);
  mocks.prisma.member.create.mockResolvedValue({ id: "member_new", email: "new@example.com" });
  mocks.prisma.member.update.mockResolvedValue({});
  mocks.prisma.$transaction.mockImplementation(async (callback) =>
    callback(mocks.prisma),
  );
  mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
  mocks.prisma.seasonalMembershipAssignment.createMany.mockResolvedValue({ count: 1 });
  mocks.prisma.auditLog.create.mockResolvedValue({});
  mocks.prisma.membershipType.findMany.mockResolvedValue([]);
  mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
    { contactGroupId: "group_1", contactId: "contact_1", contactName: "New Person" },
  ]);
  mocks.prisma.xeroContactCache.findMany.mockResolvedValue([makeContact()]);
  mocks.upsertXeroObjectLink.mockResolvedValue({});
});

describe("Xero member import — membership types (#2108)", () => {
  it("tier-only import is byte-identical to today (no type lookup / assignment / audit)", async () => {
    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" }],
      false,
    );

    expect(result.created).toBe(1);
    expect(result.assignmentsCreated).toBe(0);
    expect(mocks.prisma.member.create.mock.calls[0][0].data.ageTier).toBe("ADULT");
    expect(mocks.prisma.membershipType.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.seasonalMembershipAssignment.createMany).not.toHaveBeenCalled();
    expect(mocks.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("type-only, non-forced type: derives DOB tier and writes an IMPORT-source assignment", async () => {
    mocks.parseXeroContactDateOfBirth.mockReturnValue(new Date("2012-01-01"));
    mocks.computeAgeTier.mockResolvedValue("YOUTH");
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }, { ageTier: "YOUTH" }] },
    ]);

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.prisma.member.create.mock.calls[0][0].data.ageTier).toBe("YOUTH");
    expect(result.assignmentsCreated).toBe(1);
    const createManyArg = mocks.prisma.seasonalMembershipAssignment.createMany.mock.calls[0][0];
    expect(createManyArg.data[0]).toMatchObject({
      memberId: "member_new",
      seasonYear: 2026,
      membershipTypeId: "type_full",
      source: "IMPORT",
      sourceDetail: "Full",
      assignedByMemberId: ADMIN_ID,
    });
    expect(createManyArg.skipDuplicates).toBe(true);
  });

  it("type-only, FORCED type: new member gets N/A", async () => {
    mocks.parseXeroContactDateOfBirth.mockReturnValue(new Date("1990-01-01"));
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_org", isActive: true, allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }] },
    ]);

    await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "School", membershipTypeId: "type_org" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.prisma.member.create.mock.calls[0][0].data.ageTier).toBe("NOT_APPLICABLE");
    expect(mocks.computeAgeTier).not.toHaveBeenCalled();
  });

  it("type-only, non-forced, no DOB: falls back to ADULT", async () => {
    mocks.parseXeroContactDateOfBirth.mockReturnValue(null);
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);

    await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.prisma.member.create.mock.calls[0][0].data.ageTier).toBe("ADULT");
  });

  it("type + tier (non-forced): writes both the explicit tier and the assignment", async () => {
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }, { ageTier: "CHILD" }] },
    ]);

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full", ageTier: "CHILD" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.prisma.member.create.mock.calls[0][0].data.ageTier).toBe("CHILD");
    expect(result.assignmentsCreated).toBe(1);
    expect(mocks.prisma.seasonalMembershipAssignment.createMany.mock.calls[0][0].data[0]).toMatchObject({
      membershipTypeId: "type_full",
      source: "IMPORT",
    });
  });

  it("rejects an inactive membership type with a validation error (422 offenders)", async () => {
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_x", isActive: false, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);

    await expect(
      importMembersFromXeroGroups(
        [{ groupId: "group_1", groupName: "X", membershipTypeId: "type_x" }],
        false,
        { adminMemberId: ADMIN_ID },
      ),
    ).rejects.toBeInstanceOf(XeroMemberImportValidationError);
    expect(mocks.prisma.member.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown membership type", async () => {
    mocks.prisma.membershipType.findMany.mockResolvedValue([]);

    const error = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "X", membershipTypeId: "missing" }],
      false,
      { adminMemberId: ADMIN_ID },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(XeroMemberImportValidationError);
    expect(error.offenders).toEqual([{ membershipTypeId: "missing", reason: "not_found" }]);
  });

  it("matched-existing member with no assignment routes through the hardened save path (FORCED ⇒ N/A)", async () => {
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_existing",
      firstName: "Ada",
      lastName: "Existing",
      xeroContactId: "contact_1",
    });
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_org", isActive: true, allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }] },
    ]);
    mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
    mocks.getSeasonalMembershipChangePreview.mockResolvedValue({
      body: { preview: { previewToken: "preview-token" } },
    });
    mocks.saveSeasonalMembershipAssignment.mockResolvedValue({ body: { changed: true } });

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "School", membershipTypeId: "type_org" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(result.skippedExisting).toBe(1);
    expect(result.assignmentsCreated).toBe(1);
    // Never a bare createMany for a matched-existing member.
    expect(mocks.prisma.seasonalMembershipAssignment.createMany).not.toHaveBeenCalled();
    expect(mocks.saveSeasonalMembershipAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "member_existing",
        membershipTypeId: "type_org",
        seasonYear: 2026,
        adminMemberId: ADMIN_ID,
        reason: "Xero import: group School",
        previewToken: "preview-token",
        // #2107 adoption: per-member Xero group sync suppressed; one batched
        // reconcile runs after the loop instead.
        skipXeroContactGroupSync: true,
      }),
    );
    expect(mocks.reconcileMembersXeroContactGroups).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileMembersXeroContactGroups).toHaveBeenCalledWith(
      ["member_existing"],
      expect.objectContaining({
        createdByMemberId: ADMIN_ID,
        reason: "xero_member_import_membership_types",
      }),
    );
  });

  it("never overwrites an existing current-season assignment (reports it instead)", async () => {
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_existing",
      firstName: "Ada",
      lastName: "Existing",
      xeroContactId: "contact_1",
    });
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", name: "Full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
      { id: "type_other", name: "Other", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);
    mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([
      { memberId: "member_existing", membershipTypeId: "type_other" },
    ]);

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.saveSeasonalMembershipAssignment).not.toHaveBeenCalled();
    expect(result.assignmentsCreated).toBe(0);
    // #2108: the kept row carries resolved membership-type NAMES (never raw ids)
    // and sameType=false (a genuine DIFFERENT-type keep that needs remediation).
    expect(result.keptExistingAssignments).toEqual([
      {
        memberId: "member_existing",
        name: "Ada Existing",
        group: "Full",
        existingMembershipTypeId: "type_other",
        attemptedMembershipTypeId: "type_full",
        existingMembershipTypeName: "Other",
        attemptedMembershipTypeName: "Full",
        sameType: false,
      },
    ]);
  });

  it("flags a same-type keep as sameType (no remediation implied)", async () => {
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_existing",
      firstName: "Ada",
      lastName: "Existing",
      xeroContactId: "contact_1",
    });
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", name: "Full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);
    // Existing assignment is the SAME type the import would have assigned.
    mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([
      { memberId: "member_existing", membershipTypeId: "type_full" },
    ]);

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.saveSeasonalMembershipAssignment).not.toHaveBeenCalled();
    expect(result.keptExistingAssignments).toEqual([
      {
        memberId: "member_existing",
        name: "Ada Existing",
        group: "Full",
        existingMembershipTypeId: "type_full",
        attemptedMembershipTypeId: "type_full",
        existingMembershipTypeName: "Full",
        attemptedMembershipTypeName: "Full",
        sameType: true,
      },
    ]);
  });

  it("passes source=IMPORT into the matched-existing save path", async () => {
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_existing",
      firstName: "Ada",
      lastName: "Existing",
      xeroContactId: "contact_1",
    });
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", name: "Full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);
    mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
    mocks.getSeasonalMembershipChangePreview.mockResolvedValue({
      body: { preview: { previewToken: "preview-token" } },
    });
    mocks.saveSeasonalMembershipAssignment.mockResolvedValue({ body: { changed: true } });

    await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.saveSeasonalMembershipAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ source: "IMPORT" }),
    );
  });

  it("reports a member collision when two contacts map the same member to different types", async () => {
    // Two contacts in two groups both resolve to the SAME existing member, with
    // different type mappings. The first mapping wins; the loser is reported.
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_1", contactName: "Ada Existing" },
      { contactGroupId: "group_2", contactId: "contact_2", contactName: "Ada Alt" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      makeContact({ contactId: "contact_1", emailAddress: "ada1@example.com" }),
      makeContact({ contactId: "contact_2", emailAddress: "ada2@example.com" }),
    ]);
    // Both contacts are already linked to the same local member.
    mocks.prisma.member.findFirst.mockResolvedValue({
      id: "member_shared",
      firstName: "Ada",
      lastName: "Existing",
      xeroContactId: "contact_1",
    });
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", name: "Full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
      { id: "type_assoc", name: "Associate", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);
    mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
    mocks.getSeasonalMembershipChangePreview.mockResolvedValue({
      body: { preview: { previewToken: "preview-token" } },
    });
    mocks.saveSeasonalMembershipAssignment.mockResolvedValue({ body: { changed: true } });

    const result = await importMembersFromXeroGroups(
      [
        { groupId: "group_1", groupName: "First", membershipTypeId: "type_full" },
        { groupId: "group_2", groupName: "Second", membershipTypeId: "type_assoc" },
      ],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(result.memberCollisions).toEqual([
      {
        memberId: "member_shared",
        name: "Ada Existing",
        keptGroup: "First",
        keptMembershipTypeId: "type_full",
        droppedGroup: "Second",
        droppedMembershipTypeId: "type_assoc",
      },
    ]);
    // The winning mapping still assigns exactly once via the save path.
    expect(mocks.saveSeasonalMembershipAssignment).toHaveBeenCalledTimes(1);
    expect(mocks.saveSeasonalMembershipAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ membershipTypeId: "type_full" }),
    );
  });

  it("dedupes a contact appearing in two mapped groups (first mapping wins)", async () => {
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_1", contactName: "New Person" },
      { contactGroupId: "group_2", contactId: "contact_1", contactName: "New Person" },
    ]);
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);

    const result = await importMembersFromXeroGroups(
      [
        { groupId: "group_1", groupName: "First", membershipTypeId: "type_full" },
        { groupId: "group_2", groupName: "Second", membershipTypeId: "type_full" },
      ],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(result.created).toBe(1);
    expect(mocks.prisma.member.create).toHaveBeenCalledTimes(1);
    expect(result.droppedDuplicates).toEqual([
      { name: "New Person", xeroContactId: "contact_1", group: "Second", keptGroup: "First" },
    ]);
  });

  it("writes one summary audit row for a membership-type import", async () => {
    mocks.prisma.membershipType.findMany.mockResolvedValue([
      { id: "type_full", isActive: true, allowedAgeTiers: [{ ageTier: "ADULT" }] },
    ]);

    await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Full", membershipTypeId: "type_full" }],
      false,
      { adminMemberId: ADMIN_ID },
    );

    expect(mocks.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditEvent = mocks.buildStructuredAuditLogCreateArgs.mock
      .calls[0][0] as {
      action: string;
      severity: string;
      actor: { memberId: string };
      metadata: { seasonYear: number; membershipTypeIds: string[] };
    };
    expect(auditEvent).toMatchObject({
      action: XERO_MEMBER_IMPORT_MEMBERSHIP_TYPES_ACTION,
      severity: "important",
      actor: { memberId: ADMIN_ID },
    });
    expect(auditEvent.metadata.seasonYear).toBe(2026);
    expect(auditEvent.metadata.membershipTypeIds).toEqual(["type_full"]);
  });
});
