/**
 * #3058 — the manual Xero link asks `INV-INT-018`'s one accessor who holds a
 * contact, and asks it BEFORE spending a provider call.
 *
 * The invariant itself never broke: `commitManualXeroContactLink` refuses a
 * second home downstream, symmetrically, inside the contact-home lock. What
 * this route owned was the FRIENDLY half — the 409 that tells an officer who
 * has the contact — and it asked the member table alone. Since #3366 an
 * `Organisation` can hold a contact too, so an officer linking a member to a
 * school's own Xero customer passed the friendly refusal, paid for a
 * `getContact` round trip, and then met the raw two-homes error from the
 * commit. The explanation and the enforcement disagreed about which columns
 * count, which is precisely the drift `findXeroContactHomes` exists to stop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findXeroContactHomes: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  commitManualXeroContactLink: vi.fn(),
  memberFindUnique: vi.fn(),
  organisationFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findFirst: mocks.memberFindFirst },
    organisation: { findUnique: mocks.organisationFindUnique },
  },
}));
vi.mock("@/lib/xero-contact-home", () => ({
  findXeroContactHomes: mocks.findXeroContactHomes,
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
    mocks.findXeroContactHomes.mockResolvedValue(new Map());
  });

  it("refuses a school's organisation-held contact, in plain words and before any Xero call", async () => {
    mocks.findXeroContactHomes.mockResolvedValue(
      new Map([["contact-9", { kind: "ORGANISATION", id: "org-1" }]]),
    );
    mocks.organisationFindUnique.mockResolvedValue({ name: "St Peter's College" });

    const response = await POST(request({ xeroContactId: "contact-9" }), {
      params,
    } as never);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("St Peter's College");
    // The round trip is not spent on a link that can never be made — and the
    // commit, which is where the raw two-homes error lives, is never reached.
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.callXeroApi).not.toHaveBeenCalled();
    expect(mocks.commitManualXeroContactLink).not.toHaveBeenCalled();
  });

  it("still refuses a contact another MEMBER holds, naming them", async () => {
    mocks.findXeroContactHomes.mockResolvedValue(
      new Map([["contact-9", { kind: "MEMBER", id: "member-2" }]]),
    );
    mocks.memberFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === "member-2"
        ? { firstName: "Ada", lastName: "Lovelace" }
        : {
            id: "member-1",
            email: "member@example.test",
            passwordHash: "hash",
            xeroContactId: null,
          },
    );

    const response = await POST(request({ xeroContactId: "contact-9" }), {
      params,
    } as never);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("Ada Lovelace");
    expect(mocks.commitManualXeroContactLink).not.toHaveBeenCalled();
  });

  it("does not refuse when the member already holds the contact themselves", async () => {
    // Re-linking a member to the contact they already hold is a no-op repair,
    // not a two-homes conflict, and the old member-only check excluded it with
    // `id: { not: id }`. The accessor answers "held", so the exclusion has to
    // be made here instead.
    mocks.findXeroContactHomes.mockResolvedValue(
      new Map([["contact-9", { kind: "MEMBER", id: "member-1" }]]),
    );
    mocks.getAuthenticatedXeroClient.mockResolvedValue({ xero: {}, tenantId: "t" });
    mocks.callXeroApi.mockResolvedValue({ body: { contacts: [] } });

    const response = await POST(request({ xeroContactId: "contact-9" }), {
      params,
    } as never);

    // It got past the home check and on to the provider verification, which is
    // all this test claims; the 404 is that verification finding no contact.
    expect(mocks.getAuthenticatedXeroClient).toHaveBeenCalled();
    expect(response.status).toBe(404);
  });

  it("never asks the member table on its own about who holds a contact", async () => {
    /*
      The SSOT pin. A `member.findFirst` keyed on `xeroContactId` here is a
      second opinion on which columns count as a local home, and it is the
      opinion that was wrong about schools.
    */
    mocks.getAuthenticatedXeroClient.mockResolvedValue({ xero: {}, tenantId: "t" });
    mocks.callXeroApi.mockResolvedValue({ body: { contacts: [] } });

    await POST(request({ xeroContactId: "contact-9" }), { params } as never);

    expect(mocks.findXeroContactHomes).toHaveBeenCalledWith(expect.anything(), [
      "contact-9",
    ]);
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });
});
