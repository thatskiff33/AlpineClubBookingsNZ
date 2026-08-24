import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2314, the one place the two link rules meet in a single handler.
 *
 * Importing a Xero contact as a member writes a `XeroObjectLink` row AND hands
 * the admin a link to click. The owner's decision makes those deliberately
 * different: what is STORED stays organisation-agnostic (a short code baked into
 * a row is wrong the moment the club reconnects to a different Xero
 * organisation, and the row outlives the request), while what is RETURNED is
 * scoped now, so the click lands in this club's books.
 *
 * Before #2314 both were the same short-code-less string, so a regression that
 * collapses them back together is exactly what this pins.
 */

const ORG_SHORT_CODE = "!aBc12";
const CONTACT_ID = "xero-contact-1";

const mocks = vi.hoisted(() => ({
  getXeroOrgShortCode: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  memberFindFirst: vi.fn(),
  memberCreate: vi.fn(),
  getContact: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  syncMemberSubscriptionHistoryForLinkedContact: vi.fn(),
  ensureMemberAccessRolesFromCompatibilityFields: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("bcryptjs", () => ({ hash: async () => "hashed" }));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({
    ok: true as const,
    session: { user: { id: "admin-1" } },
  }),
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: mocks.memberFindFirst, create: mocks.memberCreate },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ member: { create: mocks.memberCreate } }),
  },
}));

vi.mock("@/lib/member-access-role-writes", () => ({
  ensureMemberAccessRolesFromCompatibilityFields:
    mocks.ensureMemberAccessRolesFromCompatibilityFields,
}));

vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: mocks.getXeroOrgShortCode,
}));

vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

// No live provider: the Xero client is a stub throughout.
vi.mock("@/lib/xero", () => ({
  getAuthenticatedXeroClient: async () => ({
    xero: { accountingApi: { getContact: mocks.getContact } },
    tenantId: "tenant-1",
  }),
  callXeroApi: async (fn: () => Promise<unknown>) => fn(),
  refreshXeroContactCachesFromContact:
    mocks.refreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact:
    mocks.syncMemberSubscriptionHistoryForLinkedContact,
}));

vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: (_err: unknown, message: string) => ({
    handled: false,
    status: 500,
    clientMessage: message,
    diagnosticMessage: message,
  }),
}));

import { POST } from "@/app/api/admin/xero/import-member-contact/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { toXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";

function request() {
  return new NextRequest(
    "http://localhost/api/admin/xero/import-member-contact",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: CONTACT_ID }),
    },
  );
}

describe("POST /api/admin/xero/import-member-contact deep links (#2314)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getXeroOrgShortCode.mockResolvedValue(ORG_SHORT_CODE);
    mocks.getContact.mockResolvedValue({
      body: { contacts: [{ contactID: CONTACT_ID, name: "Riley Chen" }] },
    });
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: {
        contactId: CONTACT_ID,
        name: "Riley Chen",
        firstName: "Riley",
        lastName: "Chen",
        emailAddress: "riley@example.org",
      },
    });
    mocks.memberFindFirst.mockResolvedValue(null);
    mocks.memberCreate.mockResolvedValue({
      id: "mem_1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.org",
      active: true,
      xeroContactId: CONTACT_ID,
    });
    mocks.syncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      errors: [],
    });
  });

  it("returns an organisation-scoped link but stores a generic one", async () => {
    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.xeroLink).toBe(
      buildXeroContactUrl(CONTACT_ID, { shortCode: ORG_SHORT_CODE }),
    );
    expect(body.xeroLink).toContain(`shortcode=${ORG_SHORT_CODE}`);

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        xeroObjectUrl: buildXeroContactUrl(CONTACT_ID),
      }),
      expect.objectContaining({ store: expect.anything() }),
    );
    // The stored URL names no organisation at all — that is what survives a
    // reconnect to a different Xero organisation.
    expect(
      mocks.upsertXeroObjectLink.mock.calls[0][0].xeroObjectUrl,
    ).not.toContain("shortcode");
  });

  /*
    INV-CONFIG-005 (#3036 review P1-8a). The guard that keeps a CONTAINED address
    out of a `Member.email` had only a source-level presence check
    (`toContain("isXeroSandboxContactEmail(")`), which cannot tell an inverted
    condition, a guard moved below `tx.member.create`, or a guard reading the
    wrong variable from a correct one. Its sibling inbound path (the bulk
    importer) always had a behavioural test; this is the missing one.

    Why it matters: `isPlaceholderContactEmail` deliberately says nothing about
    the contained domain, so a member minted from a contained address would read
    as REACHABLE on every screen — booking flows, reminder crons, admin surfaces
    — while being able to receive nothing at all. That is #2716's
    silent-unreachability defect arriving from a new direction.
  */
  it("refuses a contact whose address has been contained, and creates no member", async () => {
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: {
        contactId: CONTACT_ID,
        name: "Riley Chen",
        firstName: "Riley",
        lastName: "Chen",
        emailAddress: toXeroSandboxContactEmail("riley@example.org"),
      },
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toMatch(/replaced with a non-deliverable one/);
    expect(body.error).toMatch(/live site/);
    expect(
      mocks.memberCreate,
      "a member must not exist at all: the refusal is BEFORE the create, not a " +
        "cleanup after it",
    ).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).not.toHaveBeenCalled();
  });

  it("still imports an ordinary address, so the guard is not just refusing everything", async () => {
    // The other half of the discrimination: a placeholder domain is NOT the
    // contained domain, and the two predicates are disjoint by construction.
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: {
        contactId: CONTACT_ID,
        name: "Riley Chen",
        firstName: "Riley",
        lastName: "Chen",
        emailAddress: "riley@example.org",
      },
    });

    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.memberCreate).toHaveBeenCalledTimes(1);
  });

  it("degrades the returned link when no short code is available", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue(null);

    const body = await (await POST(request())).json();

    // Still a live link, just not organisation-scoped.
    expect(body.xeroLink).toBe(buildXeroContactUrl(CONTACT_ID));
    expect(
      mocks.upsertXeroObjectLink.mock.calls[0][0].xeroObjectUrl,
    ).toBe(buildXeroContactUrl(CONTACT_ID));
  });

  it("keeps ordinary subscription refresh failures as a successful import warning", async () => {
    mocks.syncMemberSubscriptionHistoryForLinkedContact.mockRejectedValueOnce(
      new Error("Xero history unavailable"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.memberId).toBe("mem_1");
    expect(body.warning).toMatch(/subscription history refresh did not complete/i);
  });

  it("returns the fixed 409 with truthful partial-import metadata on participant contention", async () => {
    mocks.syncMemberSubscriptionHistoryForLinkedContact.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      memberImported: true,
      memberId: "mem_1",
      xeroContactLinked: true,
      xeroContactId: CONTACT_ID,
      recoveryKind: "MEMBER_IMPORTED_AND_LINKED",
      subscriptionRefreshPending: true,
      xeroPostProcessingPending: true,
    });
  });

  it("does not claim a partial import when access-role setup rolls back the transaction", async () => {
    mocks.ensureMemberAccessRolesFromCompatibilityFields.mockRejectedValueOnce(
      new Error("private access-role detail"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to import Xero contact as member" });
    expect(JSON.stringify(body)).not.toContain("private access-role detail");
    expect(mocks.upsertXeroObjectLink).not.toHaveBeenCalled();
  });

  it("does not claim a partial import when object-link setup rolls back the transaction", async () => {
    mocks.upsertXeroObjectLink.mockRejectedValueOnce(
      new Error("private object-link detail"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to import Xero contact as member" });
    expect(JSON.stringify(body)).not.toContain("private object-link detail");
  });

  it("does not claim refresh pending when only post-refresh audit fails", async () => {
    mocks.logAudit.mockRejectedValueOnce(new Error("private audit detail"));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.recoveryKind).toBe("MEMBER_IMPORTED_AND_LINKED");
    expect(body).not.toHaveProperty("subscriptionRefreshPending");
    expect(JSON.stringify(body)).not.toContain("private audit detail");
  });
});
