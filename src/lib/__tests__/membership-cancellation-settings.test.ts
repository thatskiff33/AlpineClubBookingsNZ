import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  membershipCancellationSettingFindUnique: vi.fn(),
  membershipCancellationSettingUpsert: vi.fn(),
  membershipCancellationSettingFindUniqueOrThrow: vi.fn(),
  membershipCancellationXeroContactGroupDeleteMany: vi.fn(),
  membershipCancellationXeroContactGroupCreateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipCancellationSetting: {
      findUnique: mocks.membershipCancellationSettingFindUnique,
    },
    membershipCancellationXeroContactGroup: {},
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
  DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
  loadMembershipCancellationSettings,
  loadMembershipCancellationSettingsStrict,
  normalizeMembershipCancellationSettings,
  normalizeMembershipCancellationXeroGroups,
} from "@/lib/membership-cancellation-settings";
import {
  GET as getMembershipCancellationSettings,
  PUT as putMembershipCancellationSettings,
} from "@/app/api/admin/membership-cancellation-settings/route";

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/membership-cancellation-settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("membership cancellation settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.membershipCancellationSettingFindUnique.mockResolvedValue(null);
    mocks.membershipCancellationSettingUpsert.mockResolvedValue({});
    mocks.membershipCancellationSettingFindUniqueOrThrow.mockResolvedValue({
      id: "default",
      warningText: "Saved warning",
      rejoinProcessText: "Saved rejoin",
      xeroArchiveContactsOnCancellation: true,
      updatedByMemberId: "admin-1",
      xeroContactGroups: [
        { groupId: "group-1", groupName: "Cancelled members" },
      ],
    });
    mocks.membershipCancellationXeroContactGroupDeleteMany.mockResolvedValue({
      count: 0,
    });
    mocks.membershipCancellationXeroContactGroupCreateMany.mockResolvedValue({
      count: 1,
    });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        membershipCancellationSetting: {
          upsert: mocks.membershipCancellationSettingUpsert,
          findUniqueOrThrow:
            mocks.membershipCancellationSettingFindUniqueOrThrow,
        },
        membershipCancellationXeroContactGroup: {
          deleteMany: mocks.membershipCancellationXeroContactGroupDeleteMany,
          createMany: mocks.membershipCancellationXeroContactGroupCreateMany,
        },
      }),
    );
  });

  it("provides defaults when no settings are saved", () => {
    expect(normalizeMembershipCancellationSettings(null)).toEqual({
      warningText: DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
      rejoinProcessText: DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
      xeroArchiveContactsOnCancellation: false,
      xeroContactGroups: [],
    });
  });

  // #2392 review (NEW-1): the defaults have archiving OFF, and the unpaid-
  // invoice gate skips itself when archiving is off. A read that quietly
  // degrades to the defaults therefore turns a database blip into "no check
  // needed", while the archive — an outbox operation drained minutes later —
  // reads the setting again and archives. The gate needs the difference.
  describe("a failed read", () => {
    it("degrades to the defaults for ordinary callers", async () => {
      mocks.membershipCancellationSettingFindUnique.mockRejectedValue(
        new Error("database unavailable"),
      );

      await expect(loadMembershipCancellationSettings()).resolves.toMatchObject(
        { xeroArchiveContactsOnCancellation: false },
      );
    });

    it("throws for the caller that must not mistake it for 'archiving is off'", async () => {
      mocks.membershipCancellationSettingFindUnique.mockRejectedValue(
        new Error("database unavailable"),
      );

      await expect(
        loadMembershipCancellationSettingsStrict(),
      ).rejects.toThrow("database unavailable");
    });

    it("agrees with the ordinary loader when the read works", async () => {
      mocks.membershipCancellationSettingFindUnique.mockResolvedValue({
        warningText: "Saved warning",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [],
      });

      await expect(
        loadMembershipCancellationSettingsStrict(),
      ).resolves.toEqual(await loadMembershipCancellationSettings());
    });
  });

  it("normalizes and deduplicates Xero cancellation contact groups", () => {
    expect(
      normalizeMembershipCancellationXeroGroups([
        { groupId: " group-1 ", groupName: " Cancelled members " },
        { groupId: "group-1", groupName: "Duplicate" },
        { groupId: " ", groupName: "Blank" },
      ]),
    ).toEqual([{ groupId: "group-1", groupName: "Cancelled members" }]);
  });

  it("returns default settings from the admin API when no row exists", async () => {
    const response = await getMembershipCancellationSettings(new NextRequest("http://localhost/api/admin/membership-cancellation-settings"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.warningText).toBe(
      DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
    );
    expect(body.settings.rejoinProcessText).toBe(
      DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
    );
  });

  it("persists Xero cancellation settings and audit logs the change", async () => {
    const response = await putMembershipCancellationSettings(
      request({
        warningText: "  Saved warning  ",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [
          { groupId: " group-1 ", groupName: " Cancelled members " },
          { groupId: "group-1", groupName: "Duplicate" },
        ],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.membershipCancellationSettingUpsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: expect.objectContaining({
        warningText: "Saved warning",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        updatedByMemberId: "admin-1",
      }),
      update: expect.objectContaining({
        warningText: "Saved warning",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        updatedByMemberId: "admin-1",
      }),
    });
    expect(
      mocks.membershipCancellationXeroContactGroupCreateMany,
    ).toHaveBeenCalledWith({
      data: [
        {
          settingId: "default",
          groupId: "group-1",
          groupName: "Cancelled members",
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_CANCELLATION_SETTINGS_UPDATED",
          entityType: "MembershipCancellationSetting",
          entityId: "default",
        }),
      }),
    );
    expect(body.settings.xeroContactGroups).toEqual([
      { groupId: "group-1", groupName: "Cancelled members" },
    ]);
  });
});
