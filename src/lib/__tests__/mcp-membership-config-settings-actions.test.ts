/**
 * ALP-720 (`INV-MCP-006`, #5305 comment 7111359405): the Membership settings
 * actions an officer's AI app connection may run, each held to its contract
 * (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields, never the stored row or Finance-only detail, and the
 * browser's answer is unchanged.
 *
 * The subscription-liability rule pair keeps its second permission (owner
 * decision on #5190): a Membership-only officer's app is refused a rule
 * change exactly as their browser is, by the route's own check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    memberFieldsSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    membershipCancellationSetting: { findUnique: vi.fn(), upsert: vi.fn(), findUniqueOrThrow: vi.fn() },
    membershipCancellationXeroContactGroup: { deleteMany: vi.fn(), createMany: vi.fn() },
    membershipNominationSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    membershipLockoutSettings: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  clubPosts: { load: vi.fn(), count: vi.fn(), save: vi.fn() },
  saveLockout: vi.fn(),
  impact: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn(() => ({ data: {} })),
  getAuditRequestContext: vi.fn(() => ({})),
}));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: vi.fn(async () => ({ commsPortal: true })) }));
vi.mock("@/lib/club-post-retention", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadClubPostSettings: h.clubPosts.load,
  countPostsBeyondRetention: h.clubPosts.count,
  saveClubPostRetention: h.clubPosts.save,
}));
vi.mock("@/lib/financial-year-server", () => ({
  getFinancialYearResolution: vi.fn(async () => ({ overrideMonth: null, xeroMonth: 3, effectiveMonth: 3 })),
  refreshFinancialYearConfig: vi.fn(),
}));
vi.mock("@/lib/xero-mappings", () => ({
  getSubscriptionItemCodes: vi.fn(async () => ["SUB"]),
  getNonSubscriptionFeeItemCodes: vi.fn(async () => ["SUB"]),
}));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: async () => "Pacific/Auckland" }));
vi.mock("@/lib/subscription-liability-settings-write", async (importOriginal) => ({
  // The real refusal: the rule pair's second permission is the route's own.
  ...((await importOriginal()) as object),
  saveLockoutSettingsUnlessBusy: h.saveLockout,
}));
vi.mock("@/lib/subscription-liability-impact", () => ({ buildSubscriptionLiabilityImpact: h.impact }));

import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import { GET as getClubPostSettings, PUT as putClubPostSettings } from "@/app/api/admin/club-posts/settings/route";
import { GET as getMemberFields, PUT as putMemberFields } from "@/app/api/admin/member-fields/route";
import {
  GET as getCancellationSettings,
  PUT as putCancellationSettings,
} from "@/app/api/admin/membership-cancellation-settings/route";
import {
  GET as getNominationSettings,
  PUT as putNominationSettings,
} from "@/app/api/admin/membership-nomination-settings/route";
import { GET as getLockoutSettings, PUT as putLockoutSettings } from "@/app/api/admin/membership-lockout-settings/route";
import { GET as getLiabilityImpact } from "@/app/api/admin/membership-lockout-settings/liability-impact/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction } from "@/lib/mcp/catalogue";

import { adminSession } from "./helpers/sessions";

/** An officer with Membership edit and no Finance access. */
function membershipOnlyOfficer() {
  return adminSession({
    id: "officer-2",
    accessRoles: ["USER", "ADMIN_MEMBERSHIP"],
    adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), membership: "edit" },
  });
}

const lockoutRow = {
  id: "default",
  mode: "HARD_BLOCK",
  financialYearEndMonthOverride: null,
  textFallbackEnabled: true,
  useFeeScheduleItemCodes: false,
  requiredTypeAgeRule: "NOT_CHOSEN",
  liabilityAgeSource: "NOT_CHOSEN",
  updatedByMemberId: "officer-9",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: unknown) =>
    typeof run === "function" ? run(h.prisma) : Promise.all(run as unknown[]),
  );
  h.prisma.membershipLockoutSettings.findUnique.mockResolvedValue(lockoutRow);
  h.saveLockout.mockImplementation(async (_db: unknown, { data }: { data: object }) => ({
    record: { ...lockoutRow, ...data },
    clearedStaleRows: null,
  }));
});

describe("message board settings", () => {
  beforeEach(() => {
    h.clubPosts.load.mockResolvedValue({ retentionDays: 365, lastCleanupAt: "2026-06-30T00:00:00.000Z", lastCleanupDeleted: 4 });
    h.clubPosts.count.mockResolvedValue(12);
  });

  it("get_message_board_settings sends the period, the last clean-up and what it would delete", async () => {
    const { connection } = await expectActionContract({ actionId: "get_message_board_settings", handler: getClubPostSettings, args: {} });
    expect(connection).toEqual({
      settings: { retentionDays: 365, lastCleanupAt: "2026-06-30T00:00:00.000Z", lastCleanupDeleted: 4 },
      beyondRetention: 12,
    });
  });

  it("update_message_board_settings saves an offered period and refuses any other", async () => {
    h.clubPosts.save.mockResolvedValue({ retentionDays: 90, lastCleanupAt: null, lastCleanupDeleted: 0 });
    const { connection } = await expectActionContract({
      actionId: "update_message_board_settings",
      handler: putClubPostSettings,
      args: { retentionDays: 90 },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({ settings: { retentionDays: 90 }, beyondRetention: 12 });
    expect(h.clubPosts.save).toHaveBeenCalledWith(90, "officer-1");

    const action = findMcpAction("update_message_board_settings")!;
    const { request } = buildActionRequest(action, { retentionDays: 90 }, true);
    const refused = await putClubPostSettings(
      new Request(request.url, { method: "PUT", headers: request.headers, body: JSON.stringify({ retentionDays: 1 }) }) as never,
    );
    expect(refused.status).toBe(400);
    expect(h.clubPosts.save).toHaveBeenCalledTimes(2);
  });
});

describe("member field settings", () => {
  const settings = { showTitle: true, showGender: false, showOccupation: true, showDietaryRequirements: false };
  const row = { id: "default", ...settings, updatedAt: new Date("2026-06-01T00:00:00.000Z"), updatedByMemberId: "officer-9" };

  it("get_member_field_settings sends the switches, never who saved them", async () => {
    h.prisma.memberFieldsSettings.findUnique.mockResolvedValue(row);
    const { connection, browser } = await expectActionContract({ actionId: "get_member_field_settings", handler: getMemberFields, args: {} });
    expect(connection).toEqual({ settings, updatedAt: "2026-06-01T00:00:00.000Z" });
    expect(browser).toMatchObject({ updatedByMemberId: "officer-9" });
  });

  it("update_member_field_settings saves every switch", async () => {
    h.prisma.memberFieldsSettings.findUnique.mockResolvedValue(row);
    h.prisma.memberFieldsSettings.upsert.mockResolvedValue({ ...row, showGender: true });
    const { connection } = await expectActionContract({
      actionId: "update_member_field_settings",
      handler: putMemberFields,
      args: { settings: { ...settings, showGender: true } },
    });
    expect(connection).toMatchObject({ settings: { showGender: true } });
    expect(h.prisma.memberFieldsSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ showGender: true, updatedByMemberId: "officer-1" }) }),
    );
  });
});

describe("membership cancellation settings", () => {
  const row = {
    id: "default",
    warningText: "Cancelling ends your bookings.",
    rejoinProcessText: "Apply again.",
    xeroArchiveContactsOnCancellation: true,
    updatedByMemberId: "officer-9",
    xeroContactGroups: [{ groupId: "g-1", groupName: "Former members" }],
  };

  it("get_membership_cancellation_settings sends the settings, not the stored row", async () => {
    h.prisma.membershipCancellationSetting.findUnique.mockResolvedValue(row);
    const { connection, browser } = await expectActionContract({
      actionId: "get_membership_cancellation_settings",
      handler: getCancellationSettings,
      args: {},
    });
    expect(connection).toEqual({
      settings: {
        warningText: "Cancelling ends your bookings.",
        rejoinProcessText: "Apply again.",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [{ groupId: "g-1", groupName: "Former members" }],
      },
    });
    expect(browser).toMatchObject({ persisted: { updatedByMemberId: "officer-9" } });
  });

  it("update_membership_cancellation_settings saves the whole setting", async () => {
    h.prisma.membershipCancellationSetting.findUnique.mockResolvedValue(row);
    h.prisma.membershipCancellationSetting.findUniqueOrThrow.mockResolvedValue(row);
    await expectActionContract({
      actionId: "update_membership_cancellation_settings",
      handler: putCancellationSettings,
      args: {
        warningText: "Cancelling ends your bookings.",
        rejoinProcessText: "Apply again.",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [{ groupId: "g-1", groupName: "Former members" }],
      },
    });
    expect(h.prisma.membershipCancellationXeroContactGroup.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ settingId: "default", groupId: "g-1", groupName: "Former members" }] }),
    );
  });
});

describe("nomination settings", () => {
  const row = {
    id: "default",
    gateEnabled: true,
    minimumMembershipMonths: 12,
    minimumNights: 6,
    requiredSignOffs: 2,
    gateEffectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    updatedByMemberId: "officer-9",
  };

  it("get_membership_nomination_settings sends the rule", async () => {
    h.prisma.membershipNominationSettings.findUnique.mockResolvedValue(row);
    const { connection } = await expectActionContract({
      actionId: "get_membership_nomination_settings",
      handler: getNominationSettings,
      args: {},
    });
    expect(connection).toMatchObject({ settings: { gateEnabled: true, requiredSignOffs: 2 } });
  });

  it("update_membership_nomination_settings keeps what it was not sent", async () => {
    h.prisma.membershipNominationSettings.findUnique.mockResolvedValue(row);
    h.prisma.membershipNominationSettings.upsert.mockResolvedValue({ ...row, requiredSignOffs: 3 });
    await expectActionContract({
      actionId: "update_membership_nomination_settings",
      handler: putNominationSettings,
      args: { requiredSignOffs: 3 },
    });
    expect(h.prisma.membershipNominationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ requiredSignOffs: 3, minimumNights: 6 }) }),
    );
  });
});

describe("subscription lockout settings", () => {
  it("get_membership_lockout_settings sends the settings and year, never the Finance-only item codes", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "get_membership_lockout_settings",
      handler: getLockoutSettings,
      args: {},
    });
    expect(connection).toEqual({
      settings: expect.objectContaining({ mode: "HARD_BLOCK", requiredTypeAgeRule: "NOT_CHOSEN" }),
      financialYear: { overrideMonth: null, xeroMonth: 3, effectiveMonth: 3 },
    });
    // The officer holds Finance: the browser still gets the codes.
    expect(browser).toMatchObject({ feeScheduleItemCodes: ["SUB"], overlappingCodes: ["SUB"] });
  });

  it("update_membership_lockout_settings changes the mode for a Membership-only officer", async () => {
    h.auth.mockResolvedValue(membershipOnlyOfficer());
    const { connection } = await expectActionContract({
      actionId: "update_membership_lockout_settings",
      handler: putLockoutSettings,
      args: { mode: "NON_MEMBER_PRICING" },
    });
    expect(connection).toMatchObject({ settings: { mode: "NON_MEMBER_PRICING" } });
  });

  it("refuses a Membership-only officer's app a liability rule change, as the website does, and saves nothing", async () => {
    h.auth.mockResolvedValue(membershipOnlyOfficer());
    const action = findMcpAction("update_membership_lockout_settings")!;
    const args = { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" };
    for (const viaConnection of [true, false]) {
      const { request } = buildActionRequest(action, args, viaConnection);
      const response = await putLockoutSettings(request as never);
      expect(response.status, viaConnection ? "connection" : "browser").toBe(403);
      expect(await response.json()).toEqual({
        error: "Choosing the subscription liability rule needs both Membership edit and Finance edit access.",
      });
    }
    expect(h.saveLockout).not.toHaveBeenCalled();
  });

  it("lets an officer with Membership and Finance edit change the liability rule, and says how many records it reset", async () => {
    h.saveLockout.mockImplementation(async (_db: unknown, { data }: { data: object }) => ({
      record: { ...lockoutRow, ...data },
      clearedStaleRows: { clearedCount: 2, clearedMemberIds: ["member-4", "member-5"] },
    }));
    const { connection } = await expectActionContract({
      actionId: "update_membership_lockout_settings",
      handler: putLockoutSettings,
      args: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
    });
    expect(connection).toMatchObject({
      settings: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
      clearedStaleRecords: 2,
    });
    // The reset members' ids stay in the audit log, not the app's answer.
    expect(JSON.stringify(connection)).not.toContain("member-4");
    expect(h.saveLockout).toHaveBeenCalled();
  });

  it("preview_subscription_liability_rule names who changes, never their unpaid invoice numbers", async () => {
    const member = { memberId: "member-2", name: "Ana Hale", billingChanges: true, accessChanges: false };
    h.impact.mockResolvedValue({
      seasonYear: 2026,
      current: { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
      proposed: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
      newlyOwing: [member],
      noLongerOwing: [{ ...member, memberId: "member-3", unpaidInvoiceNumber: "INV-0042" }],
      staleRecords: [{ memberId: "member-4", name: "Kai Hale" }],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "preview_subscription_liability_rule",
      handler: getLiabilityImpact,
      args: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
    });
    expect(JSON.stringify(connection)).not.toContain("INV-0042");
    expect(browser).toMatchObject({ impact: { noLongerOwing: [{ unpaidInvoiceNumber: "INV-0042" }] } });
  });
});
