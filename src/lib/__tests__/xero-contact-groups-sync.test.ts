import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberGroupingResolution } from "@/lib/xero-member-grouping";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getContact: vi.fn(),
  createContactGroupContacts: vi.fn(),
  deleteContactGroupContact: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  buildXeroPayloadHash: vi.fn(() => "hash"),
  completeXeroSyncOperation: vi.fn(),
  completeMemberContactOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  loadXeroGroupingContext: vi.fn(),
  resolveMemberGroupingForMember: vi.fn(),
  isXeroConnected: vi.fn(),
}));

vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.memberFindUnique } },
}));

vi.mock("@/lib/xero-api-client", () => ({
  callXeroApi: mocks.callXeroApi,
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (
    ...parts: Array<string | number | boolean | null | undefined>
  ) =>
    parts
      .filter((p): p is string | number | boolean => p !== null && p !== undefined && p !== "")
      .map((p) => String(p))
      .join(":"),
  buildXeroPayloadHash: mocks.buildXeroPayloadHash,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
}));

vi.mock("@/lib/xero-contact-create-recovery", () => ({
  completeMemberContactOperation: mocks.completeMemberContactOperation,
}));

vi.mock("@/lib/xero-contact-cache", () => ({
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE: "CONTACT_GROUP_CACHE",
  CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE: "CONTACT_GROUP_FULL_REFRESH",
  extractActiveXeroContactGroups: (contact: { contactGroups?: Array<{ contactGroupID: string; name: string }> }) =>
    (contact.contactGroups ?? []).map((g) => ({ id: g.contactGroupID, name: g.name })),
  fetchXeroContactsByIdsFromXero: vi.fn(),
  refreshXeroContactCachesFromContact: mocks.refreshXeroContactCachesFromContact,
  upsertXeroContactCacheEntry: vi.fn(),
}));

vi.mock("@/lib/xero-sync-cursors", () => ({
  DEFAULT_XERO_SYNC_SCOPE: "default",
  getXeroSyncCursor: vi.fn(),
  toPrismaJson: (v: unknown) => v,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: (id: string) => `https://xero/${id}`,
}));

vi.mock("@/lib/xero-member-grouping", async (importActual) => {
  const actual = (await importActual()) as typeof import("@/lib/xero-member-grouping");
  return {
    ...actual,
    loadXeroGroupingContext: mocks.loadXeroGroupingContext,
    resolveMemberGroupingForMember: mocks.resolveMemberGroupingForMember,
  };
});

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  syncManagedXeroContactGroupForMember,
  triggerMemberXeroContactGroupSync,
} from "@/lib/xero-contact-groups";

function xeroClient() {
  return {
    accountingApi: {
      getContact: mocks.getContact,
      createContactGroupContacts: mocks.createContactGroupContacts,
      deleteContactGroupContact: mocks.deleteContactGroupContact,
    },
  };
}

function contactWithGroups(groups: Array<{ contactGroupID: string; name: string }>) {
  return { body: { contacts: [{ contactID: "contact_1", contactGroups: groups }] } };
}

function resolution(overrides: Partial<MemberGroupingResolution>): MemberGroupingResolution {
  return {
    mode: "MEMBERSHIP_TYPE_AND_AGE",
    managedGroup: null,
    acceptedGroupIds: [],
    managedUniverse: [],
    skippedReason: null,
    ...overrides,
  };
}

describe("syncManagedXeroContactGroupForMember (mode-driven engine)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callXeroApi.mockImplementation(async (runner: () => unknown) => runner());
    mocks.getAuthenticatedXeroClient.mockResolvedValue({ xero: xeroClient(), tenantId: "t1" });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue({});
    mocks.completeMemberContactOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue({});
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue(undefined);
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE", activeRules: [] });
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      ageTier: "ADULT",
      firstName: "Ada",
      lastName: "Lovelace",
      xeroContactId: "contact_1",
    });
  });

  it("skips (no Xero call) when the member has no Xero contact", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      ageTier: "ADULT",
      firstName: "Ada",
      lastName: "Lovelace",
      xeroContactId: null,
    });
    const result = await syncManagedXeroContactGroupForMember("member_1");
    expect(result.skippedReason).toBe("member_has_no_xero_contact");
    expect(mocks.getContact).not.toHaveBeenCalled();
  });

  it("NONE mode is a total no-op and never calls Xero", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "NONE", activeRules: [] });
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({ mode: "NONE", skippedReason: "grouping_mode_none" }),
    );
    const result = await syncManagedXeroContactGroupForMember("member_1");
    expect(result.skippedReason).toBe("grouping_mode_none");
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.getContact).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("no_matching_rule refreshes cache but performs no Xero writes or ledger", async () => {
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({ skippedReason: "no_matching_rule" }),
    );
    mocks.getContact.mockResolvedValue(contactWithGroups([{ contactGroupID: "g_old", name: "Old" }]));
    const result = await syncManagedXeroContactGroupForMember("member_1");
    expect(result.skippedReason).toBe("no_matching_rule");
    expect(mocks.createContactGroupContacts).not.toHaveBeenCalled();
    expect(mocks.deleteContactGroupContact).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.refreshXeroContactCachesFromContact).toHaveBeenCalled();
  });

  it("adds the managed group and removes an unexpected managed group", async () => {
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({
        managedGroup: { id: "g_adult", name: "Adults" },
        acceptedGroupIds: ["g_adult"],
        managedUniverse: ["g_adult", "g_youth"],
      }),
    );
    mocks.getContact.mockResolvedValue(contactWithGroups([{ contactGroupID: "g_youth", name: "Youth" }]));
    const result = await syncManagedXeroContactGroupForMember("member_1");
    expect(mocks.createContactGroupContacts).toHaveBeenCalledWith(
      "t1",
      "g_adult",
      expect.anything(),
      // Per-operation nonce (#1934 review): the add key embeds the ledger
      // operation id so a legitimate later re-add within Xero's 24h
      // idempotency window is not swallowed.
      "contact:contact_1:contact-group-add:g_adult:op_1:v2",
    );
    expect(mocks.deleteContactGroupContact).toHaveBeenCalledWith("t1", "g_youth", "contact_1");
    expect(result.addedGroupIds).toEqual(["g_adult"]);
    expect(result.removedGroupIds).toEqual(["g_youth"]);
    expect(result.alreadyAbsentGroupIds).toEqual([]);
    expect(mocks.completeMemberContactOperation).toHaveBeenCalled();
  });

  // INV-PRIV-011 (#2683 review). The enqueued payload carried
  // `memberName: "${firstName} ${lastName}"` — never sent to Xero, present only
  // so the admin operations panel could label the row — and it was written into
  // XeroSyncOperation.requestPayload on every managed-group sync. The panel now
  // labels the row with the member id it already stores.
  it("does not store the member's composed name on the ledger operation", async () => {
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({
        managedGroup: { id: "g_adult", name: "Adults" },
        acceptedGroupIds: ["g_adult"],
        managedUniverse: ["g_adult", "g_youth"],
      }),
    );
    mocks.getContact.mockResolvedValue(contactWithGroups([{ contactGroupID: "g_youth", name: "Youth" }]));

    await syncManagedXeroContactGroupForMember("member_1");

    const stored = (mocks.startXeroSyncOperation.mock.calls as unknown as Array<
      [{ requestPayload: Record<string, unknown> }]
    >)[0][0].requestPayload;
    expect(stored).not.toHaveProperty("memberName");
    expect(JSON.stringify(stored)).not.toContain("Lovelace");
    // The member id is still there, which is what the panel labels the row with.
    expect(stored.memberId).toBe("member_1");

    // The idempotency key is built from the payload as composed, INCLUDING the
    // name, so stripping the stored copy cannot orphan an in-flight operation.
    expect(mocks.buildXeroPayloadHash).toHaveBeenCalledWith(
      expect.objectContaining({ memberName: "Ada Lovelace" }),
    );
  });

  it("suppresses the add when already in an accepted group (no-op, no ledger)", async () => {
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({
        managedGroup: { id: "g_adult", name: "Adults" },
        acceptedGroupIds: ["g_adult", "g_adult_legacy"],
        managedUniverse: ["g_adult", "g_adult_legacy"],
      }),
    );
    mocks.getContact.mockResolvedValue(
      contactWithGroups([{ contactGroupID: "g_adult_legacy", name: "Legacy" }]),
    );
    const result = await syncManagedXeroContactGroupForMember("member_1");
    expect(mocks.createContactGroupContacts).not.toHaveBeenCalled();
    expect(mocks.deleteContactGroupContact).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(result.addedGroupIds).toEqual([]);
  });

  it("treats a remove-404 as already-absent success, not a removal", async () => {
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({
        managedGroup: { id: "g_adult", name: "Adults" },
        acceptedGroupIds: ["g_adult"],
        managedUniverse: ["g_adult", "g_youth"],
      }),
    );
    mocks.getContact.mockResolvedValue(contactWithGroups([{ contactGroupID: "g_youth", name: "Youth" }]));
    mocks.deleteContactGroupContact.mockRejectedValue(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );
    const result = await syncManagedXeroContactGroupForMember("member_1");
    // The 404 is idempotent success but must not be counted as a removal.
    expect(result.removedGroupIds).toEqual([]);
    expect(result.alreadyAbsentGroupIds).toEqual(["g_youth"]);
    expect(mocks.completeMemberContactOperation).toHaveBeenCalledWith(
      "member_1",
      "contact_1",
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          removedGroupIds: [],
          alreadyAbsentGroupIds: ["g_youth"],
        }),
      }),
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("treats an add-404 as a ledgered failure", async () => {
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({
        managedGroup: { id: "g_adult", name: "Adults" },
        acceptedGroupIds: ["g_adult"],
        managedUniverse: ["g_adult"],
      }),
    );
    mocks.getContact.mockResolvedValue(contactWithGroups([]));
    mocks.createContactGroupContacts.mockRejectedValue(
      Object.assign(new Error("group not found"), { statusCode: 404 }),
    );
    await expect(syncManagedXeroContactGroupForMember("member_1")).rejects.toThrow(/not found/i);
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith("op_1", expect.anything());
    expect(mocks.completeMemberContactOperation).not.toHaveBeenCalled();
  });
});

describe("triggerMemberXeroContactGroupSync (best-effort)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callXeroApi.mockImplementation(async (runner: () => unknown) => runner());
    mocks.getAuthenticatedXeroClient.mockResolvedValue({ xero: xeroClient(), tenantId: "t1" });
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "NONE", activeRules: [] });
    mocks.resolveMemberGroupingForMember.mockResolvedValue(
      resolution({ mode: "NONE", skippedReason: "grouping_mode_none" }),
    );
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      ageTier: "ADULT",
      firstName: "Ada",
      lastName: "Lovelace",
      xeroContactId: "contact_1",
    });
  });

  it("does nothing when Xero is not connected", async () => {
    mocks.isXeroConnected.mockResolvedValue(false);
    await triggerMemberXeroContactGroupSync("member_1", { reason: "cron_age_up" });
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("runs the sync when Xero is connected", async () => {
    mocks.isXeroConnected.mockResolvedValue(true);
    await triggerMemberXeroContactGroupSync("member_1", { reason: "cron_age_up" });
    expect(mocks.memberFindUnique).toHaveBeenCalled();
  });

  it("swallows sync failures (never throws) and re-runs idempotently", async () => {
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.memberFindUnique.mockRejectedValueOnce(new Error("boom"));
    // First call: sync throws internally, trigger swallows it.
    await expect(
      triggerMemberXeroContactGroupSync("member_1", { reason: "cron_age_up" }),
    ).resolves.toBeUndefined();
    // Re-run: member has no contact -> sync is a clean no-op, still no throw.
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      ageTier: "ADULT",
      firstName: "Ada",
      lastName: "Lovelace",
      xeroContactId: null,
    });
    await expect(
      triggerMemberXeroContactGroupSync("member_1", { reason: "cron_age_up" }),
    ).resolves.toBeUndefined();
  });
});
