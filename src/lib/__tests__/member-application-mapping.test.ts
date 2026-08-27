import { beforeEach, describe, expect, it, vi } from "vitest";

// E10 (#1936): unit tests for the shared mapping engine — deterministic
// per-person outcome computation, the HMAC preview token (row + outcome drift),
// the collision policy, and ranked candidate suggestions.

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    memberApplication: { findUnique: vi.fn() },
    member: { findMany: vi.fn(), findFirst: vi.fn() },
    // No ageTierSetting model: loadMappingAgeTierSettings falls back to the
    // configured defaults, exactly like an empty table.
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/email", () => ({}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
}));
vi.mock("@/lib/membership-subscription-billing", () => ({
  queueApprovedMembershipSubscriptionCharges: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/induction", () => ({ createMemberInduction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

import {
  buildApprovalMappingPreview,
  buildApprovalMappingPreviewToken,
  computeApprovalMappingOutcomes,
  PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE,
  PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
  verifyApprovalMappingPreviewToken,
  type MappingApplicationInput,
  type MappingTargetRecord,
} from "@/lib/member-application-mapping";
import type { NormalizedPersonDecision } from "@/lib/member-application-decisions";
import {
  normalizeAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/policies/age-tier";

// The configured default boundaries (what an empty AgeTierSetting table
// resolves to) plus a full-admin actor, used unless a test overrides them.
const DEFAULT_SETTINGS: AgeTierSettingData[] = normalizeAgeTierSettings([]);
const FULL_ADMIN = { id: "admin-1", isFullAdmin: true };
const SCOPED_ADMIN = { id: "admin-2", isFullAdmin: false };

function makeApplication(
  overrides: Partial<MappingApplicationInput> = {},
): MappingApplicationInput {
  return {
    id: "app-1",
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    applicantEmail: "jane@test.com",
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    applicantPhone: "64 21 5551234",
    applicantAddress: null,
    familyMembers: [],
    nominator1Id: "nom-1",
    nominator2Id: "nom-2",
    ...overrides,
  };
}

function makeTarget(overrides: Partial<MappingTargetRecord> = {}): MappingTargetRecord {
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
    // #2255: read by the nomination approval so it can refuse writing the
    // applicant into BOTH parent slots of a member they are already the second
    // parent of. Required, not optional, so a fixture cannot omit it and leave
    // that guard reading `undefined`.
    secondaryParentId: null,
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

const applicantMapDecisions = (memberId: string): NormalizedPersonDecision[] => [
  { ref: { kind: "applicant" }, decision: { mode: "MAP", memberId } },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeApprovalMappingOutcomes — applicant MAP", () => {
  it("diffs name/email, flags promotion, and blocks a foreign login holder", async () => {
    const target = makeTarget({ id: "member-x", canLogin: false });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: "someone-else",
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    const applicant = persons[0];
    expect(applicant.mode).toBe("MAP");
    expect(applicant.loginPromoted).toBe(true);
    expect(applicant.keepAuth).toBe(false);
    const emailDiff = applicant.fieldDiffs.find((diff) => diff.field === "email");
    expect(emailDiff).toMatchObject({ current: "old@test.com", incoming: "jane@test.com", willChange: true });
    expect(applicant.errors).toContain(
      "The application email is already used by a different member who can log in.",
    );
  });

  it("relaxes the login-email guard when the login holder IS the target (keep-auth)", async () => {
    const target = makeTarget({ id: "member-x", canLogin: true, email: "jane@test.com" });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: "member-x",
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[0].errors).toEqual([]);
    expect(persons[0].keepAuth).toBe(true);
    expect(persons[0].loginPromoted).toBe(false);
  });

  it("blocks mapping to a nominator, an inactive/archived member, and an already-grouped member", async () => {
    const nominatorTarget = makeTarget({ id: "nom-1" });
    const nominatorOutcome = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("nom-1"),
      targetsById: new Map([["nom-1", nominatorTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(nominatorOutcome.persons[0].errors.join(" ")).toContain("nominator");

    const inactive = makeTarget({ id: "m-inactive", active: false });
    const inactiveOutcome = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("m-inactive"),
      targetsById: new Map([["m-inactive", inactive]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(inactiveOutcome.persons[0].errors.join(" ")).toContain("inactive or archived");

    const grouped = makeTarget({ id: "m-grouped", familyGroupMemberships: [{ familyGroupId: "fg-9" }] });
    const groupedOutcome = await computeApprovalMappingOutcomes({
      application: makeApplication({
        familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
      }),
      decisions: [
        { ref: { kind: "applicant" }, decision: { mode: "MAP", memberId: "m-grouped" } },
        { ref: { kind: "family", index: 0 }, decision: { mode: "CREATE" } },
      ],
      targetsById: new Map([["m-grouped", grouped]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(groupedOutcome.persons[0].errors.join(" ")).toContain("already belongs to a family group");
  });

  it("skips billing with a note when the target already has season coverage", async () => {
    const target = makeTarget({ id: "member-x", subscriptions: [{ id: "sub-1" }] });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[0].skipSeasonalAssignment).toBe(true);
    expect(persons[0].notes.join(" ")).toContain("existing season membership coverage");
  });
});

describe("computeApprovalMappingOutcomes — family MAP", () => {
  const familyApp = () =>
    makeApplication({
      familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
    });
  const familyDecisions = (memberId: string): NormalizedPersonDecision[] => [
    { ref: { kind: "applicant" }, decision: { mode: "CREATE" } },
    { ref: { kind: "family", index: 0 }, decision: { mode: "MAP", memberId } },
  ];

  it("blocks an ADMIN member mapped as a dependent", async () => {
    const admin = makeTarget({ id: "m-admin", role: "ADMIN" });
    const { persons } = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: familyDecisions("m-admin"),
      targetsById: new Map([["m-admin", admin]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[1].errors.join(" ")).toContain("admin member cannot be mapped as a dependent");
  });

  it("sets the parent link only for a non-login target with no parent; notes otherwise", async () => {
    const fresh = makeTarget({ id: "m-fresh", canLogin: false, parentMemberId: null });
    const freshOutcome = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: familyDecisions("m-fresh"),
      targetsById: new Map([["m-fresh", fresh]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(freshOutcome.persons[1].setParentLink).toBe(true);

    const loginable = makeTarget({ id: "m-login", canLogin: true });
    const loginableOutcome = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: familyDecisions("m-login"),
      targetsById: new Map([["m-login", loginable]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(loginableOutcome.persons[1].setParentLink).toBe(false);
    expect(loginableOutcome.persons[1].notes.join(" ")).toContain("left untouched");
  });

  it("blocks the same member mapped to two people (duplicate target)", async () => {
    const target = makeTarget({ id: "dup" });
    const { blockingErrors } = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: [
        { ref: { kind: "applicant" }, decision: { mode: "MAP", memberId: "dup" } },
        { ref: { kind: "family", index: 0 }, decision: { mode: "MAP", memberId: "dup" } },
      ],
      targetsById: new Map([["dup", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(blockingErrors.join(" ")).toContain("cannot be mapped to more than one person");
  });
});

describe("preview token drift", () => {
  it("verifies a matching payload and rejects row-level and outcome-only drift", async () => {
    const application = makeApplication();
    const decisions = applicantMapDecisions("member-x");
    const target = makeTarget({ id: "member-x" });

    const base = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    const token = buildApprovalMappingPreviewToken({
      application,
      persons: base.persons,
      blockingErrors: base.blockingErrors,
    });
    expect(
      verifyApprovalMappingPreviewToken(
        { application, persons: base.persons, blockingErrors: base.blockingErrors },
        token,
      ),
    ).toBe(true);

    // Row-level drift: the target's updatedAt advances.
    const editedTarget = makeTarget({
      id: "member-x",
      updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    });
    const rowDrift = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", editedTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(
      verifyApprovalMappingPreviewToken(
        { application, persons: rowDrift.persons, blockingErrors: rowDrift.blockingErrors },
        token,
      ),
    ).toBe(false);

    // Outcome-only drift: neither row changed, but an AgeTierSetting boundary
    // edit reclassifies the applicant, so the recomputed tier — and the token
    // payload — change.
    const editedBoundaries: AgeTierSettingData[] = [
      { tier: "YOUTH", minAge: 0, maxAge: null, label: "Everyone", sortOrder: 1 },
    ];
    const outcomeDrift = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: editedBoundaries,
    });
    expect(
      verifyApprovalMappingPreviewToken(
        { application, persons: outcomeDrift.persons, blockingErrors: outcomeDrift.blockingErrors },
        token,
      ),
    ).toBe(false);

    // Actor-privilege drift (fail closed): the same rows recomputed by a
    // scoped admin against a privileged, email-changing target produce a
    // different (blocking) outcome, so a Full-Admin-minted token is refused.
    const privilegedTarget = makeTarget({
      id: "member-x",
      canLogin: true,
      accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinitionId: null }],
    });
    const fullAdminOutcome = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", privilegedTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    const fullAdminToken = buildApprovalMappingPreviewToken({
      application,
      persons: fullAdminOutcome.persons,
      blockingErrors: fullAdminOutcome.blockingErrors,
    });
    const scopedRecompute = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", privilegedTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: SCOPED_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(scopedRecompute.persons[0].errors).toContain(
      PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE,
    );
    expect(
      verifyApprovalMappingPreviewToken(
        {
          application,
          persons: scopedRecompute.persons,
          blockingErrors: scopedRecompute.blockingErrors,
        },
        fullAdminToken,
      ),
    ).toBe(false);
  });
});

describe("privileged-email mapping gate (#1026 parity)", () => {
  const privileged = (overrides: Partial<MappingTargetRecord> = {}) =>
    makeTarget({
      id: "member-x",
      canLogin: true,
      email: "officer@test.com",
      accessRoles: [{ role: "ADMIN_MEMBERSHIP", roleDefinitionId: null }],
      ...overrides,
    });

  it("blocks a scoped admin whose mapping would change a privileged member's email", async () => {
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", privileged()]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: SCOPED_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[0].errors).toContain(PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE);
  });

  it("allows a Full Admin to make the same mapping", async () => {
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", privileged()]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[0].errors).not.toContain(
      PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE,
    );
  });

  it("does not gate a same-email mapping, an unprivileged target, or a non-login target", async () => {
    // Same email: nothing to take over.
    const sameEmail = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", privileged({ email: "jane@test.com" })]]),
      loginHolderId: "member-x",
      seasonYear: 2026,
      actor: SCOPED_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(sameEmail.persons[0].errors).toEqual([]);

    // Unprivileged login target: the ordinary member-edit rules apply.
    const unprivileged = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([
        ["member-x", privileged({ accessRoles: [{ role: "USER", roleDefinitionId: null }] })],
      ]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: SCOPED_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(unprivileged.persons[0].errors).toEqual([]);

    // Non-login target (promotion path): hasPrivilegedAccess is canLogin-aware
    // so the EMAIL gate stays silent — but the target dormantly stores a
    // privileged role, so the canLogin-BLIND PROMOTION gate (#1604 parity,
    // dedicated describe below) blocks it instead.
    const nonLogin = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", privileged({ canLogin: false })]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: SCOPED_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(nonLogin.persons[0].errors).not.toContain(
      PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE,
    );
    expect(nonLogin.persons[0].errors).toContain(
      PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
    );
  });

  it("exempts the actor's own record, mirroring direct member edit", async () => {
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", privileged()]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: { id: "member-x", isFullAdmin: false },
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[0].errors).not.toContain(
      PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE,
    );
  });
});

describe("privileged promotion mapping gate (#1604 parity, canLogin-blind)", () => {
  // A cancelled ex-admin: canLogin already false, but the access-role row is
  // dormantly stored. hasPrivilegedAccess is false for this target — only the
  // canLogin-BLIND memberHoldsPrivilegedRole sees the dormant role.
  const dormant = (overrides: Partial<MappingTargetRecord> = {}) =>
    makeTarget({
      id: "member-x",
      canLogin: false,
      email: "dormant@test.com",
      accessRoles: [{ role: "ADMIN", roleDefinitionId: null }],
      ...overrides,
    });

  const outcomesFor = (target: MappingTargetRecord, actor: { id: string; isFullAdmin: boolean }) =>
    computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor,
      ageTierSettings: DEFAULT_SETTINGS,
    });

  it("blocks a scoped admin promoting a non-login target with a dormant ADMIN role", async () => {
    const { persons } = await outcomesFor(dormant(), SCOPED_ADMIN);
    expect(persons[0].errors).toContain(
      PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
    );
    // The canLogin-aware email gate stays silent for a non-login target.
    expect(persons[0].errors).not.toContain(
      PRIVILEGED_MAPPING_EMAIL_GUARD_MESSAGE,
    );
  });

  it("blocks the FINANCE_ADMIN access-role and legacy financeAccessLevel (dormant Treasurer) variants", async () => {
    const financeRole = await outcomesFor(
      dormant({ accessRoles: [{ role: "FINANCE_ADMIN", roleDefinitionId: null }] }),
      SCOPED_ADMIN,
    );
    expect(financeRole.persons[0].errors).toContain(
      PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
    );

    // Legacy dormant Treasurer: no access-role rows at all, the privilege
    // lives only in the financeAccessLevel column — which
    // loadApprovalMappingTargets now selects for exactly this predicate.
    const legacyTreasurer = await outcomesFor(
      dormant({ accessRoles: [], financeAccessLevel: "MANAGER" }),
      SCOPED_ADMIN,
    );
    expect(legacyTreasurer.persons[0].errors).toContain(
      PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
    );
  });

  it("allows a Full Admin to promote the same dormant-privileged target", async () => {
    const { persons } = await outcomesFor(dormant(), FULL_ADMIN);
    expect(persons[0].errors).toEqual([]);
    expect(persons[0].loginPromoted).toBe(true);
  });

  it("does not gate a non-privileged non-login promotion by a scoped admin", async () => {
    const { persons } = await outcomesFor(
      dormant({ accessRoles: [], role: "USER", financeAccessLevel: null }),
      SCOPED_ADMIN,
    );
    expect(persons[0].errors).toEqual([]);
    expect(persons[0].loginPromoted).toBe(true);
  });

  it("exempts the actor's own record, mirroring the sibling #1604 guards", async () => {
    const { persons } = await outcomesFor(dormant(), {
      id: "member-x",
      isFullAdmin: false,
    });
    expect(persons[0].errors).not.toContain(
      PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
    );
  });

  it("fails closed on replay: a Full-Admin-minted token is refused for the scoped-admin recompute", async () => {
    const application = makeApplication();
    const decisions = applicantMapDecisions("member-x");
    const target = dormant();

    const fullAdminOutcome = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(fullAdminOutcome.persons[0].errors).toEqual([]);
    const fullAdminToken = buildApprovalMappingPreviewToken({
      application,
      persons: fullAdminOutcome.persons,
      blockingErrors: fullAdminOutcome.blockingErrors,
    });

    const scopedRecompute = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: SCOPED_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(scopedRecompute.persons[0].errors).toContain(
      PRIVILEGED_MAPPING_PROMOTION_GUARD_MESSAGE,
    );
    expect(
      verifyApprovalMappingPreviewToken(
        {
          application,
          persons: scopedRecompute.persons,
          blockingErrors: scopedRecompute.blockingErrors,
        },
        fullAdminToken,
      ),
    ).toBe(false);
  });
});

describe("applicant MAP — dependent-record note", () => {
  it("adds an informational (non-blocking) note when the target has a parent link", async () => {
    const dependentTarget = makeTarget({
      id: "member-x",
      canLogin: false,
      parentMemberId: "parent-1",
    });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", dependentTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });
    expect(persons[0].errors).toEqual([]);
    expect(persons[0].notes.join(" ")).toContain(
      "linked as a dependent of another member",
    );
  });
});

describe("buildApprovalMappingPreview", () => {
  function previewApplicationRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "app-1",
      updatedAt: new Date("2026-04-12T00:00:00.000Z"),
      applicantEmail: "jane@test.com",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
      applicantPhone: "64 21 5551234",
      applicantAddress: null,
      familyMembers: [],
      nominator1Id: null,
      nominator2Id: null,
      status: "PENDING_ADMIN",
      ...overrides,
    };
  }

  it("ranks an exact email match ahead of a name-only match", async () => {
    prismaMock.memberApplication.findUnique.mockResolvedValue(previewApplicationRow());
    prismaMock.member.findFirst.mockResolvedValue(null); // no login holder
    // Suggestions query (applicant person).
    prismaMock.member.findMany.mockResolvedValue([
      { id: "name-only", firstName: "Jane", lastName: "Doe", email: "different@test.com", ageTier: "ADULT", active: true, canLogin: true },
      { id: "email-hit", firstName: "Janet", lastName: "Doering", email: "jane@test.com", ageTier: "ADULT", active: true, canLogin: true },
    ]);

    const result = await buildApprovalMappingPreview({
      applicationId: "app-1",
      personDecisions: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
    });
    const body = result.body as {
      preview: { persons: Array<{ suggestions: Array<{ id: string; matchedOnEmail: boolean }> }>; hasMappings: boolean };
    };
    expect(body.preview.hasMappings).toBe(false);
    expect(body.preview.persons[0].suggestions[0]).toMatchObject({ id: "email-hit", matchedOnEmail: true });
  });

  it("409s an application that is not pending admin review", async () => {
    prismaMock.memberApplication.findUnique.mockResolvedValue(
      previewApplicationRow({ status: "APPROVED" }),
    );

    const result = await buildApprovalMappingPreview({
      applicationId: "app-1",
      personDecisions: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
    });

    expect(result.init?.status).toBe(409);
    expect((result.body as { error: string }).error).toContain(
      "pending admin review",
    );
    // Fails before any member read.
    expect(prismaMock.member.findMany).not.toHaveBeenCalled();
    expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
  });
});
