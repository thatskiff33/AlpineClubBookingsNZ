/**
 * ALP-721 (`INV-MCP-006`): the Finance area's Xero contact and invoice
 * actions, each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields, so
 *   an email address, a Xero contact, document or group id, a deep link or an
 *   erased member's record id the finance screen reads never reaches the AI
 *   provider;
 * - the browser's answer is unchanged;
 * - the request the catalogue builds is the one the route accepts, and money
 *   travels as integer cents.
 *
 * The route's own guard is stubbed to admit a finance officer: who may call
 * each route is the route map's and the guard's job, tested with them.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdate: vi.fn(),
  logAudit: vi.fn(),
  createAuditLog: vi.fn(),
  checkRateLimit: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  findXeroContactLinkConflict: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  commitManualXeroContactLink: vi.fn(),
  flushMemberSubscriptionHistory: vi.fn(),
  syncMemberSubscriptionHistoryForLinkedContact: vi.fn(),
  getXeroOrgShortCode: vi.fn(),
  createXeroContactForMember: vi.fn(),
  findPotentialXeroContactsForMember: vi.fn(),
  findDuplicateContacts: vi.fn(),
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn(),
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
  deactivateXeroObjectLinks: vi.fn(),
  listXeroCashCreditQueue: vi.fn(),
  refreshXeroCashCredits: vi.fn(),
  getXeroMemberGroupingSnapshot: vi.fn(),
  resyncXeroContactCachesByIds: vi.fn(),
  getXeroContactLinkMismatchSnapshot: vi.fn(),
  getErasedMemberXeroContactReview: vi.fn(),
  checkErasedMemberContactStatuses: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroMissingContactSnapshot: vi.fn(),
  runXeroMissingContactSeedingChunk: vi.fn(),
  getMissingXeroInvoiceBookings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: h.memberFindUnique, findMany: h.memberFindMany, update: h.memberUpdate } },
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit, createAuditLog: h.createAuditLog }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: h.checkRateLimit,
  rateLimitedResponse: vi.fn(() => new Response("Too many requests", { status: 429 })),
  getClientIp: vi.fn(() => "203.0.113.9"),
}));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/xero-link-short-code", () => ({ getXeroOrgShortCode: h.getXeroOrgShortCode }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: h.getAuthenticatedXeroClient,
  callXeroApi: h.callXeroApi,
}));
vi.mock("@/lib/xero-contact-home", () => ({ findXeroContactLinkConflict: h.findXeroContactLinkConflict }));
vi.mock("@/lib/xero-contact-cache", () => ({
  refreshXeroContactCachesFromContact: h.refreshXeroContactCachesFromContact,
}));
vi.mock("@/lib/xero-manual-contact-link", () => ({ commitManualXeroContactLink: h.commitManualXeroContactLink }));
vi.mock("@/lib/xero-membership-sync", () => ({
  flushMemberSubscriptionHistory: h.flushMemberSubscriptionHistory,
  syncMemberSubscriptionHistoryForLinkedContact: h.syncMemberSubscriptionHistoryForLinkedContact,
}));
vi.mock("@/lib/xero-contacts", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-contacts")),
  createXeroContactForMember: h.createXeroContactForMember,
}));
vi.mock("@/lib/xero-duplicate-contacts", () => ({
  findPotentialXeroContactsForMember: h.findPotentialXeroContactsForMember,
  findDuplicateContacts: h.findDuplicateContacts,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: h.enqueueXeroEntranceFeeInvoiceOperation,
  enqueueXeroBookingInvoiceOperation: h.enqueueXeroBookingInvoiceOperation,
  processQueuedXeroOutboxOperations: h.processQueuedXeroOutboxOperations,
}));
vi.mock("@/lib/xero-sync", () => ({ deactivateXeroObjectLinks: h.deactivateXeroObjectLinks }));
vi.mock("@/lib/xero-cash-credits", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-cash-credits")),
  listXeroCashCreditQueue: h.listXeroCashCreditQueue,
  refreshXeroCashCredits: h.refreshXeroCashCredits,
}));
vi.mock("@/lib/xero-member-grouping-resync", () => ({
  getXeroMemberGroupingSnapshot: h.getXeroMemberGroupingSnapshot,
}));
vi.mock("@/lib/xero-mismatch-resync", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mismatch-resync")),
  resyncXeroContactCachesByIds: h.resyncXeroContactCachesByIds,
}));
vi.mock("@/lib/xero-contact-link-mismatches", () => ({
  getXeroContactLinkMismatchSnapshot: h.getXeroContactLinkMismatchSnapshot,
}));
vi.mock("@/lib/xero-erased-member-contact-review", () => ({
  getErasedMemberXeroContactReview: h.getErasedMemberXeroContactReview,
}));
vi.mock("@/lib/xero-erased-member-contact-status-check", () => ({
  checkErasedMemberContactStatuses: h.checkErasedMemberContactStatuses,
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: h.isXeroConnected }));
vi.mock("@/lib/xero-missing-contact-seeding", () => ({
  getXeroMissingContactSnapshot: h.getXeroMissingContactSnapshot,
}));
vi.mock("@/lib/xero-missing-contact-seeding-run", () => ({
  runXeroMissingContactSeedingChunk: h.runXeroMissingContactSeedingChunk,
}));
vi.mock("@/lib/xero-admin-health", () => ({ getMissingXeroInvoiceBookings: h.getMissingXeroInvoiceBookings }));

import { POST as linkMember } from "@/app/api/admin/members/[id]/xero-link/route";
import { POST as pushMember } from "@/app/api/admin/members/[id]/xero-push/route";
import { POST as unlinkMember } from "@/app/api/admin/members/[id]/xero-unlink/route";
import { GET as listCashCredits, POST as refreshCashCredits } from "@/app/api/admin/xero/cash-credits/route";
import {
  GET as listGroupMismatches,
  POST as resyncGroupMismatches,
} from "@/app/api/admin/xero/contact-group-mismatches/route";
import {
  GET as listLinkMismatches,
  POST as resyncLinkMismatches,
} from "@/app/api/admin/xero/contact-link-mismatches/route";
import { GET as listDuplicateContacts } from "@/app/api/admin/xero/duplicate-contacts/route";
import {
  GET as listErasedContacts,
  POST as checkErasedContacts,
} from "@/app/api/admin/xero/erased-member-contacts/route";
import {
  GET as listMissingContacts,
  POST as runMissingContacts,
} from "@/app/api/admin/xero/missing-contacts/route";
import {
  GET as listMissingInvoices,
  POST as queueMissingInvoices,
} from "@/app/api/admin/xero/missing-invoices/route";
import { GET as searchContacts } from "@/app/api/admin/xero/search-contacts/route";
import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const financeOfficer = adminSession({ id: "treasurer-1", accessRoles: ["USER", "FINANCE_ADMIN"] });

/** Withheld from every connection answer below; each fixture carries some. */
const WITHHELD = /@example\.org|xero-contact-uuid|xero-doc-uuid|xero-group-uuid|go\.xero\.com|erased-member-7/;

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: financeOfficer });
  h.getXeroOrgShortCode.mockResolvedValue("!abc12");
  h.getAuthenticatedXeroClient.mockResolvedValue({ xero: {}, tenantId: "tenant-1" });
  h.checkRateLimit.mockResolvedValue({ success: true });
});

describe("search_xero_contacts", () => {
  it("answers with the contact id, name and who holds it, never the email address", async () => {
    h.callXeroApi.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "xero-contact-uuid-1", name: "Aroha Ngata", emailAddress: "aroha@example.org" },
        ],
      },
    });
    h.memberFindMany
      // Members already linked to a listed contact.
      .mockResolvedValueOnce([
        { id: "member-2", xeroContactId: "xero-contact-uuid-1", firstName: "Aroha", lastName: "Ngata" },
      ])
      // Members sharing a listed contact's name.
      .mockResolvedValueOnce([{ id: "member-2", firstName: "Aroha", lastName: "Ngata" }])
      .mockResolvedValueOnce([
        { id: "member-2", xeroContactId: "xero-contact-uuid-1", firstName: "Aroha", lastName: "Ngata" },
      ])
      .mockResolvedValueOnce([{ id: "member-2", firstName: "Aroha", lastName: "Ngata" }]);

    const { connection, browser } = await expectActionContract({
      actionId: "search_xero_contacts",
      handler: searchContacts,
      args: { q: "Aroha" },
    });
    // The contact id is the one value the link action needs: it must survive.
    expect(connection).toEqual({
      contacts: [
        {
          contactId: "xero-contact-uuid-1",
          name: "Aroha Ngata",
          isLinked: true,
          linkedMemberId: "member-2",
          linkedMemberName: "Aroha Ngata",
          existingMemberId: "member-2",
          existingMemberName: "Aroha Ngata",
        },
      ],
    });
    expect(JSON.stringify(connection)).not.toMatch(/@example\.org/);
    expect(browser).toEqual({
      contacts: [
        {
          contactId: "xero-contact-uuid-1",
          name: "Aroha Ngata",
          firstName: "Aroha",
          lastName: "Ngata",
          email: "aroha@example.org",
          isLinked: true,
          linkedMemberId: "member-2",
          linkedMemberName: "Aroha Ngata",
          existingMemberId: "member-2",
          existingMemberName: "Aroha Ngata",
          canImportAsMember: false,
          importBlockReason: "Already linked to Aroha Ngata",
        },
      ],
    });
  });
});

describe("link_member_to_xero_contact", () => {
  it("links the member to the contact the app named, without the deep link", async () => {
    h.memberFindUnique.mockResolvedValue({
      id: "member-7",
      firstName: "Aroha",
      lastName: "Ngata",
      email: "aroha@example.org",
      deletedAt: null,
      xeroContactId: null,
    });
    h.findXeroContactLinkConflict.mockResolvedValue(null);
    h.callXeroApi.mockResolvedValue({ body: { contacts: [{ contactID: "xero-contact-uuid-1", name: "Aroha Ngata" }] } });
    h.flushMemberSubscriptionHistory.mockResolvedValue({ deletedCount: 1, seasonYears: [] });
    // A season that did not refresh, so the answer carries its warning.
    h.syncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({ errors: ["2026"], seasonYears: [2026] });

    const { connection, browser } = await expectActionContract({
      actionId: "link_member_to_xero_contact",
      handler: linkMember,
      args: { id: "member-7", xeroContactId: "xero-contact-uuid-1" },
    });
    expect(connection).toEqual({
      xeroContactId: "xero-contact-uuid-1",
      contactName: "Aroha Ngata",
      warning: expect.stringContaining("Member linked"),
    });
    expect(JSON.stringify(connection)).not.toMatch(/go\.xero\.com|!abc12/);
    expect(browser).toEqual({ ...(connection as object), xeroLink: expect.stringContaining("xero-contact-uuid-1") });
    // The member in the path and the contact in the body reach the commit.
    expect(h.commitManualXeroContactLink).toHaveBeenCalledWith({
      memberId: "member-7",
      xeroContactId: "xero-contact-uuid-1",
      contactName: "Aroha Ngata",
    });
  });
});

describe("create_xero_contact_for_member", () => {
  const ARGS = {
    id: "member-7",
    entranceFeeInvoiceDecision: "CREATE",
    entranceFeeInvoiceAmountCents: 15_000,
    forceCreate: true,
  };

  beforeEach(() => {
    h.memberFindUnique.mockResolvedValue({
      id: "member-7",
      firstName: "Aroha",
      lastName: "Ngata",
      email: "aroha@example.org",
      deletedAt: null,
      xeroContactId: null,
    });
  });

  it("creates the contact and queues the joining fee invoice in cents", async () => {
    h.createXeroContactForMember.mockResolvedValue("xero-contact-uuid-9");
    h.flushMemberSubscriptionHistory.mockResolvedValue({ deletedCount: 0, seasonYears: [] });
    h.syncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({ errors: ["2026"], seasonYears: [2026] });
    h.enqueueXeroEntranceFeeInvoiceOperation.mockResolvedValue({ queueOperationId: "op-1", message: "Joining fee invoice queued" });

    const { connection, browser } = await expectActionContract({
      actionId: "create_xero_contact_for_member",
      handler: pushMember,
      args: ARGS,
    });
    expect(connection).toEqual({
      entranceFeeInvoiceQueued: true,
      entranceFeeInvoiceMessage: "Joining fee invoice queued",
      warning: expect.stringContaining("Xero contact created"),
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({
      ...(connection as object),
      xeroContactId: "xero-contact-uuid-9",
      xeroLink: expect.stringContaining("xero-contact-uuid-9"),
    });
    // The amount the app sent in cents is the invoice's amount.
    expect(h.enqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledWith(
      "member-7",
      expect.objectContaining({ amountCents: 15_000, createdByMemberId: "treasurer-1" }),
    );
  });

  it("names the look-alike contacts to a connection without their email or deep link", async () => {
    const suggestion = {
      contactId: "xero-contact-uuid-3",
      name: "Aroha Ngata",
      email: "aroha@example.org",
      isLinked: false,
      linkedMemberName: null,
      matchReasons: ["Exact email match"],
      xeroLink: "https://go.xero.com/Contacts/View/xero-contact-uuid-3",
    };
    h.findPotentialXeroContactsForMember.mockResolvedValue([suggestion]);
    const call = (viaConnection: boolean) =>
      pushMember(
        new NextRequest("https://club.example.test/api/admin/members/member-7/xero-push", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(viaConnection ? { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" } : {}),
          },
          body: JSON.stringify({}),
        }),
        { params: Promise.resolve({ id: "member-7" }) },
      );

    const connection = await call(true);
    expect(connection.status).toBe(409);
    const refusal = await connection.json();
    // The contact id stays: it is what the link action takes next.
    expect(refusal.suggestedContacts).toEqual([
      { contactId: "xero-contact-uuid-3", name: "Aroha Ngata", isLinked: false, linkedMemberName: null, matchReasons: ["Exact email match"] },
    ]);
    expect(JSON.stringify(refusal)).not.toMatch(/@example\.org|go\.xero\.com/);

    const browser = await call(false);
    expect(browser.status).toBe(409);
    expect((await browser.json()).suggestedContacts).toEqual([suggestion]);
  });

  it("refuses a fractional joining fee amount before the route sees it", () => {
    const schema = mcpActionInputSchema(findMcpAction("create_xero_contact_for_member")!);
    expect(schema.safeParse({ ...ARGS, entranceFeeInvoiceAmountCents: 150.5 }).success).toBe(false);
  });
});

describe("unlink_member_from_xero_contact", () => {
  it("unlinks the member in the path and says how much history was cleared", async () => {
    h.memberFindUnique.mockResolvedValue({
      id: "member-7",
      firstName: "Aroha",
      lastName: "Ngata",
      xeroContactId: "xero-contact-uuid-1",
    });
    h.flushMemberSubscriptionHistory.mockResolvedValue({ deletedCount: 3, seasonYears: [2026] });

    const { connection, browser } = await expectActionContract({
      actionId: "unlink_member_from_xero_contact",
      handler: unlinkMember,
      args: { id: "member-7" },
    });
    expect(connection).toEqual({ success: true, clearedSubscriptionHistoryCount: 3 });
    expect(browser).toEqual(connection);
    expect(h.memberUpdate).toHaveBeenCalledWith({ where: { id: "member-7" }, data: { xeroContactId: null } });
  });
});

describe("cash credits", () => {
  const QUEUE = {
    refreshedAt: "2026-06-30T01:00:00.000Z",
    rows: [
      {
        id: "cash-1",
        kind: "OVERPAYMENT",
        xeroDocumentId: "xero-doc-uuid-1",
        xeroContactId: "xero-contact-uuid-1",
        currencyCode: "NZD",
        documentDate: "2026-06-01",
        totalCents: 12_000,
        remainingCents: 4_500,
        member: { id: "member-7", name: "Aroha Ngata" },
      },
    ],
  };

  it("list_xero_cash_credits answers in cents without the Xero document or contact ids", async () => {
    h.listXeroCashCreditQueue.mockResolvedValue(QUEUE);
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_cash_credits",
      handler: listCashCredits,
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(QUEUE);
  });

  it("refresh_xero_cash_credits answers with the counts and the refreshed queue", async () => {
    const result = { open: 1, written: 1, zeroed: 0, current: true };
    h.refreshXeroCashCredits.mockResolvedValue(result);
    h.listXeroCashCreditQueue.mockResolvedValue(QUEUE);
    const { connection, browser } = await expectActionContract({
      actionId: "refresh_xero_cash_credits",
      handler: refreshCashCredits,
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ result, queue: QUEUE });
    // Each run is rate limited per officer, as on the website.
    expect(h.checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }), "treasurer-1");
  });
});

const RESYNC = { requestedContacts: 1, resyncedContacts: 1, removedContacts: 0, resyncedAt: "2026-07-01T00:00:00.000Z" };

describe("contact group mismatches", () => {
  const SNAPSHOT = {
    mode: "MEMBERSHIP_TYPE",
    cacheReady: true,
    lastRefreshedAt: "2026-06-30T01:00:00.000Z",
    rulesFingerprint: "fingerprint-1",
    plannedDigest: "digest-1",
    activeRuleCount: 2,
    membersConsidered: 40,
    mismatchCount: 1,
    addCount: 1,
    removeCount: 1,
    estimatedXeroCalls: 2,
    skippedNoContact: [{ memberId: "member-8", memberName: "Tama Rangi" }],
    mismatches: [
      {
        memberId: "member-7",
        memberName: "Aroha Ngata",
        memberEmail: "aroha@example.org",
        ageTier: "ADULT",
        xeroContactId: "xero-contact-uuid-1",
        managedGroup: { id: "xero-group-uuid-1", name: "Senior members" },
        addGroupId: "xero-group-uuid-1",
        removeGroupIds: ["xero-group-uuid-2"],
      },
    ],
    informationalCount: 1,
    informational: [
      {
        memberId: "member-9",
        memberName: "Ski School",
        memberEmail: "office@example.org",
        ageTier: "ADULT",
        xeroContactId: "xero-contact-uuid-2",
        unexpectedManagedGroupIds: ["xero-group-uuid-1"],
        unexpectedManagedGroups: [{ id: "xero-group-uuid-1", name: "Senior members" }],
      },
    ],
  };

  it("list_xero_contact_group_mismatches answers by member and group name", async () => {
    h.getXeroMemberGroupingSnapshot.mockResolvedValue(SNAPSHOT);
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_contact_group_mismatches",
      handler: listGroupMismatches,
      args: { limit: 50 },
    });
    expect(JSON.stringify(connection)).not.toMatch(/@example\.org|xero-contact-uuid|xero-group-uuid|digest-1|fingerprint-1/);
    expect(browser).toEqual(SNAPSHOT);
    expect(h.getXeroMemberGroupingSnapshot).toHaveBeenCalledWith({ limit: 50 });
  });

  it("resync_xero_contact_group_mismatches re-reads the flagged contacts", async () => {
    h.getXeroMemberGroupingSnapshot.mockResolvedValue(SNAPSHOT);
    h.resyncXeroContactCachesByIds.mockResolvedValue(RESYNC);
    const { connection, browser } = await expectActionContract({
      actionId: "resync_xero_contact_group_mismatches",
      handler: resyncGroupMismatches,
      args: { limit: 25 },
    });
    expect(JSON.stringify(connection)).not.toMatch(/@example\.org|xero-contact-uuid|xero-group-uuid/);
    expect(browser).toEqual({ ...SNAPSHOT, resync: RESYNC });
    // The resync is asked about both kinds of flagged contact, as on the website.
    expect(h.resyncXeroContactCachesByIds).toHaveBeenCalledWith(
      ["xero-contact-uuid-1", "xero-contact-uuid-2"],
      "adminXeroContactGroupMismatchResync",
    );
    expect(h.getXeroMemberGroupingSnapshot).toHaveBeenCalledWith({ limit: 25 });
  });
});

describe("contact link mismatches", () => {
  const SNAPSHOT = {
    cacheReady: true,
    lastRefreshedAt: "2026-06-30T01:00:00.000Z",
    count: 1,
    mismatches: [
      {
        memberId: "member-7",
        memberName: "Aroha Ngata",
        memberEmail: "aroha@example.org",
        active: true,
        xeroContactId: "xero-contact-uuid-1",
        xeroContactName: "A Ngata Trust",
        xeroContactEmail: "trust@example.org",
        reasons: ["Full name differs"],
      },
    ],
  };

  it("list_xero_contact_link_mismatches answers by name and reason", async () => {
    h.getXeroContactLinkMismatchSnapshot.mockResolvedValue(SNAPSHOT);
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_contact_link_mismatches",
      handler: listLinkMismatches,
      args: { limit: 10 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(SNAPSHOT);
    expect(h.getXeroContactLinkMismatchSnapshot).toHaveBeenCalledWith({ limit: 10 });
  });

  it("resync_xero_contact_link_mismatches re-reads the flagged contacts", async () => {
    h.getXeroContactLinkMismatchSnapshot.mockResolvedValue(SNAPSHOT);
    h.resyncXeroContactCachesByIds.mockResolvedValue(RESYNC);
    const { connection, browser } = await expectActionContract({
      actionId: "resync_xero_contact_link_mismatches",
      handler: resyncLinkMismatches,
      args: { limit: 10 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ ...SNAPSHOT, resync: RESYNC });
    expect(h.getXeroContactLinkMismatchSnapshot).toHaveBeenCalledWith({ limit: 10 });
  });
});

describe("list_xero_duplicate_contacts", () => {
  it("answers with names and invoice counts, never the shared email address or deep links", async () => {
    const RESULT = {
      duplicateGroups: [
        {
          email: "aroha@example.org",
          contacts: [
            {
              contactID: "xero-contact-uuid-1",
              name: "Aroha Ngata",
              firstName: "Aroha",
              lastName: "Ngata",
              emailAddress: "aroha@example.org",
              hasInvoices: true,
              invoiceCount: 4,
              contactStatus: "ACTIVE",
              updatedDateUTC: "2026-05-01T00:00:00.000Z",
              xeroLink: "https://go.xero.com/Contacts/View/xero-contact-uuid-1",
              memberId: "member-7",
              memberActive: true,
            },
          ],
          canCreateFamilyGroup: true,
          eligibleMemberIds: ["member-7", "member-8"],
          suggestedGroupName: "Ngata family",
        },
      ],
      totalContacts: 120,
      totalDuplicateEmails: 1,
      filteredByFamilyGroup: 0,
    };
    h.findDuplicateContacts.mockResolvedValue(RESULT);
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_duplicate_contacts",
      handler: listDuplicateContacts,
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(RESULT);
    expect(h.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "xero-duplicate-contacts-scan", limit: 10 }),
      "treasurer-1",
    );
  });

  it("refuses an officer over the scan limit before it reads Xero", async () => {
    h.checkRateLimit.mockResolvedValue({ success: false });
    const response = await listDuplicateContacts(
      new NextRequest("https://club.example.test/api/admin/xero/duplicate-contacts"),
    );
    expect(response.status).toBe(429);
    expect(h.findDuplicateContacts).not.toHaveBeenCalled();
  });
});

describe("erased-member contacts", () => {
  const REVIEW = {
    needsReview: 1,
    alreadyRetiredInXero: 2,
    rows: [
      {
        memberId: "erased-member-7",
        xeroContactId: "xero-contact-uuid-1",
        erasure: "ANONYMISED_BY_DELETION_REQUEST",
        erasedAt: "2026-03-01T00:00:00.000Z",
        contactStatus: "UNKNOWN",
        contactStatusCheckedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    truncated: false,
    lastContactStatusCheckAt: "2026-06-01T00:00:00.000Z",
    contactCacheLastRefreshedAt: "2026-06-30T00:00:00.000Z",
    contactCacheAgeHours: 24,
    contactCacheStale: false,
  };

  it("list_erased_member_xero_contacts identifies neither the erased member nor the contact", async () => {
    h.getErasedMemberXeroContactReview.mockResolvedValue(REVIEW);
    const { connection, browser } = await expectActionContract({
      actionId: "list_erased_member_xero_contacts",
      handler: listErasedContacts,
      args: { limit: 20 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ review: REVIEW });
    expect(h.getErasedMemberXeroContactReview).toHaveBeenCalledWith({ limit: 20 });
  });

  it("check_erased_member_xero_contacts asks Xero about the listed contacts only", async () => {
    const CHECK = { checkedContacts: 1, observedContacts: 1, notFoundInXero: 0, retiredInXero: 0, checkedAt: "2026-07-01T00:00:00.000Z" };
    h.getErasedMemberXeroContactReview.mockResolvedValue(REVIEW);
    h.checkErasedMemberContactStatuses.mockResolvedValue(CHECK);
    const { connection, browser } = await expectActionContract({
      actionId: "check_erased_member_xero_contacts",
      handler: checkErasedContacts,
      args: { limit: 20 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ review: REVIEW, check: CHECK });
    expect(h.checkErasedMemberContactStatuses).toHaveBeenCalledWith(["xero-contact-uuid-1"]);
    expect(h.getErasedMemberXeroContactReview).toHaveBeenCalledWith({ limit: 20 });
  });

  it("still lists the default rows for a browser that sends a bad limit", async () => {
    h.getErasedMemberXeroContactReview.mockResolvedValue(REVIEW);
    const response = await listErasedContacts(
      new NextRequest("https://club.example.test/api/admin/xero/erased-member-contacts?limit=2.5"),
    );
    expect(response.status).toBe(200);
    expect(h.getErasedMemberXeroContactReview).toHaveBeenCalledWith({ limit: 200 });
  });
});

describe("missing contacts", () => {
  const SNAPSHOT = {
    cacheReady: true,
    plannedDigest: "plan-digest-1",
    chunkSize: 25,
    estimatedXeroCallsPerChunk: 100,
    eligible: 40,
    alreadyLinked: 30,
    unlinked: 10,
    pushable: 1,
    excluded: 1,
    ambiguous: 1,
    pushableRows: [
      { memberId: "member-7", memberName: "Aroha Ngata", memberEmail: "aroha@example.org", evidence: "CACHED_CONTACT_MATCH", cachedXeroContactId: "xero-contact-uuid-1" },
    ],
    excludedRows: [{ memberId: "member-8", memberName: "Tama Rangi", memberEmail: "tama@example.org", reason: "NO_EMAIL" }],
    ambiguousRows: [
      { memberId: "member-9", memberName: "Mere Rangi", memberEmail: "mere@example.org", reason: "MULTIPLE_CACHED_MATCHES", xeroContactIds: ["xero-contact-uuid-2", "xero-contact-uuid-3"] },
    ],
    contactCacheLastRefreshedAt: "2026-06-30T00:00:00.000Z",
    contactCacheAgeHours: 24,
    contactCacheStale: false,
  };

  it("list_members_missing_xero_contacts keeps the digest and member ids the run takes", async () => {
    h.getXeroMissingContactSnapshot.mockResolvedValue(SNAPSHOT);
    const { connection, browser } = await expectActionContract({
      actionId: "list_members_missing_xero_contacts",
      handler: listMissingContacts,
      args: { limit: 100 },
    });
    expect(connection).toMatchObject({ snapshot: { plannedDigest: "plan-digest-1", pushableRows: [{ memberId: "member-7" }] } });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ snapshot: SNAPSHOT, notReadyMessage: null });
    expect(h.getXeroMissingContactSnapshot).toHaveBeenCalledWith({ limit: 100 });
  });

  it("still lists the default rows for a browser that sends an out-of-range limit", async () => {
    h.getXeroMissingContactSnapshot.mockResolvedValue(SNAPSHOT);
    await listMissingContacts(new NextRequest("https://club.example.test/api/admin/xero/missing-contacts?limit=5000"));
    expect(h.getXeroMissingContactSnapshot).toHaveBeenCalledWith({ limit: 500 });
  });

  it("create_missing_xero_contacts runs the reviewed plan and answers member by member", async () => {
    const RESULT = {
      processed: 1,
      linkedExisting: 1,
      created: 0,
      resolvedUnlabelled: 0,
      failed: 1,
      failures: [{ memberId: "member-9", kind: "OTHER", error: "Xero refused the contact" }],
      outcomes: [
        { memberId: "member-7", memberName: "Aroha Ngata", memberEmail: "aroha@example.org", outcome: "linked", xeroContactId: "xero-contact-uuid-1", plannedEvidence: "CACHED_CONTACT_MATCH", kind: null, error: null },
        { memberId: "member-9", memberName: "Mere Rangi", memberEmail: "mere@example.org", outcome: "failed", xeroContactId: null, plannedEvidence: "NO_CACHED_MATCH", kind: "OTHER", error: "Xero refused the contact" },
      ],
      skipped: [{ memberId: "member-8", reason: "NO_LONGER_PUSHABLE" }],
      remaining: 0,
      outstandingPushable: 0,
      done: true,
      haltedByDailyLimit: false,
      haltedByTimeBudget: false,
    };
    h.isXeroConnected.mockResolvedValue(true);
    h.runXeroMissingContactSeedingChunk.mockResolvedValue(RESULT);
    const { connection, browser } = await expectActionContract({
      actionId: "create_missing_xero_contacts",
      handler: runMissingContacts,
      args: { confirmReviewed: true, memberIds: ["member-7", "member-8", "member-9"], plannedDigest: "plan-digest-1", limit: 10 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ result: RESULT });
    // The reviewed set and its digest are what the engine checks before it touches anybody.
    expect(h.runXeroMissingContactSeedingChunk).toHaveBeenCalledWith({
      reviewedMemberIds: ["member-7", "member-8", "member-9"],
      reviewedPlannedDigest: "plan-digest-1",
      limit: 10,
      createdByMemberId: "treasurer-1",
    });
  });

  it("is refused without the officer's confirmation", () => {
    const schema = mcpActionInputSchema(findMcpAction("create_missing_xero_contacts")!);
    expect(schema.safeParse({ memberIds: ["member-7"], plannedDigest: "plan-digest-1" }).success).toBe(false);
  });
});

describe("missing invoices", () => {
  const SNAPSHOT = {
    count: 1,
    bookings: [
      {
        bookingId: "booking-1",
        paymentId: "pay-1",
        memberId: "member-7",
        memberName: "Aroha Ngata",
        memberEmail: "aroha@example.org",
        status: "PAID",
        checkIn: "2026-07-10T00:00:00.000Z",
        checkOut: "2026-07-12T00:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ],
  };

  it("list_bookings_missing_xero_invoices answers by booking and member name", async () => {
    h.getMissingXeroInvoiceBookings.mockResolvedValue(SNAPSHOT);
    const { connection, browser } = await expectActionContract({
      actionId: "list_bookings_missing_xero_invoices",
      handler: listMissingInvoices,
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(SNAPSHOT);
  });

  it("queue_missing_xero_invoices queues each booking and says why any were skipped", async () => {
    h.getMissingXeroInvoiceBookings.mockResolvedValue({
      count: 2,
      bookings: [SNAPSHOT.bookings[0], { ...SNAPSHOT.bookings[0], bookingId: "booking-2" }],
    });
    h.enqueueXeroBookingInvoiceOperation
      .mockResolvedValueOnce({ queueOperationId: "op-1", message: "Queued" })
      .mockResolvedValueOnce({ queueOperationId: null, message: "Already invoiced" })
      .mockResolvedValueOnce({ queueOperationId: "op-2", message: "Queued" })
      .mockResolvedValueOnce({ queueOperationId: null, message: "Already invoiced" });
    const { connection, browser } = await expectActionContract({
      actionId: "queue_missing_xero_invoices",
      handler: queueMissingInvoices,
    });
    const expected = {
      ok: true,
      found: 2,
      queued: 1,
      skipped: 1,
      skippedBookings: [{ bookingId: "booking-2", reason: "Already invoiced" }],
      message: "Queued 1 missing booking invoice for background processing.",
    };
    expect(connection).toEqual(expected);
    expect(browser).toEqual(expected);
    expect(h.enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("booking-1", {
      createdByMemberId: "treasurer-1",
      invoiceEmailDelivery: null,
    });
  });
});
