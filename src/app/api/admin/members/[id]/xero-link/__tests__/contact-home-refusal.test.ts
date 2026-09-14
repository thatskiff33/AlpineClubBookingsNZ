/**
 * #3058 — the manual Xero link asks who holds a contact BEFORE it spends a
 * provider call, and asks `INV-INT-018`'s own module rather than answering the
 * question itself.
 *
 * The rule's behaviour — which columns count, what the refusal says, when it is
 * a no-op repair rather than a conflict — is proved in
 * `src/lib/__tests__/xero-contact-link-conflict.test.ts`, beside the module
 * that owns it. What is proved HERE is what only the route can be wrong about:
 * the ORDER (before the `getContact`), the status, and that the route does not
 * grow a second opinion of its own.
 *
 * Before this, that opinion was a `member.findFirst` on `xeroContactId` over
 * the member table alone, run AFTER the provider round trip — so since #3366 a
 * school's ORGANISATION-held contact passed the friendly refusal, cost a Xero
 * call, and then met the raw two-homes error from the commit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findXeroContactLinkConflict: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  commitManualXeroContactLink: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  organisationFindFirst: vi.fn(),
  organisationFindUnique: vi.fn(),
  organisationFindMany: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
      findFirst: mocks.memberFindFirst,
      findMany: mocks.memberFindMany,
    },
    organisation: {
      findFirst: mocks.organisationFindFirst,
      findUnique: mocks.organisationFindUnique,
      findMany: mocks.organisationFindMany,
    },
  },
}));
vi.mock("@/lib/xero-contact-home", () => ({
  findXeroContactLinkConflict: mocks.findXeroContactLinkConflict,
}));
vi.mock("@/lib/xero", () => ({
  callXeroApi: mocks.callXeroApi,
  flushMemberSubscriptionHistory: vi.fn(),
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  refreshXeroContactCachesFromContact: vi.fn(),
  syncMemberSubscriptionHistoryForLinkedContact: vi.fn(),
}));
vi.mock("@/lib/xero-manual-contact-link", () => ({
  commitManualXeroContactLink: mocks.commitManualXeroContactLink,
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/xero-link-short-code", () => ({ getXeroOrgShortCode: vi.fn() }));

import { POST } from "../route";

function request(body: unknown) {
  return new Request("https://club.test/api/admin/members/member-1/xero-link", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}

const params = Promise.resolve({ id: "member-1" });

describe("manual Xero contact link — who already holds it (#3058)", () => {
  beforeEach(() => {
    for (const stub of Object.values(mocks)) stub.mockReset();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      email: "member@example.test",
      passwordHash: "hash",
      xeroContactId: null,
    });
    mocks.findXeroContactLinkConflict.mockResolvedValue(null);
  });

  it("refuses before any Xero call, in the words the rule gave it", async () => {
    mocks.findXeroContactLinkConflict.mockResolvedValue({
      message:
        "Xero contact contact-9 is already the Xero customer for organisation " +
        "St Peter's College (INV-INT-018).",
    });

    const response = await POST(request({ xeroContactId: "contact-9" }), {
      params,
    } as never);

    expect(response.status).toBe(409);
    // Passed through verbatim: the officer's explanation and the refusal the
    // commit would raise are one string, so they cannot drift apart.
    expect((await response.json()).error).toContain("St Peter's College");
    expect(mocks.findXeroContactLinkConflict).toHaveBeenCalledWith(
      expect.anything(),
      { xeroContactId: "contact-9", claimingMemberId: "member-1" },
    );
    // The round trip is not spent on a link that can never be made, and the
    // commit — where that refusal otherwise surfaces, raw — is never reached.
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.callXeroApi).not.toHaveBeenCalled();
    expect(mocks.commitManualXeroContactLink).not.toHaveBeenCalled();
  });

  it("goes on to verify the contact when nothing holds it", async () => {
    mocks.getAuthenticatedXeroClient.mockResolvedValue({ xero: {}, tenantId: "t" });
    mocks.callXeroApi.mockResolvedValue({ body: { contacts: [] } });

    const response = await POST(request({ xeroContactId: "contact-9" }), {
      params,
    } as never);

    expect(mocks.getAuthenticatedXeroClient).toHaveBeenCalled();
    // The 404 is that verification finding no contact, which is all this test
    // claims: the ownership question said yes and the route moved on.
    expect(response.status).toBe(404);
  });

  it("keeps no second opinion of its own about who holds a contact", async () => {
    /*
      The SSOT pin. A `member.findFirst` keyed on `xeroContactId` here — or a
      read of the organisation record — is a second reader of "which columns
      count as a local home", and it is the reader that was wrong about schools.
    */
    mocks.getAuthenticatedXeroClient.mockResolvedValue({ xero: {}, tenantId: "t" });
    mocks.callXeroApi.mockResolvedValue({ body: { contacts: [] } });

    await POST(request({ xeroContactId: "contact-9" }), { params } as never);

    expect(mocks.findXeroContactLinkConflict).toHaveBeenCalledTimes(1);
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
    expect(mocks.organisationFindFirst).not.toHaveBeenCalled();
    expect(mocks.organisationFindUnique).not.toHaveBeenCalled();
    expect(mocks.organisationFindMany).not.toHaveBeenCalled();
  });
});
