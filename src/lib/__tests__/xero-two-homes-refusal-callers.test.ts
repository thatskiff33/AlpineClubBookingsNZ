/**
 * #2939 — where the `INV-INT-018` two-homes refusal LANDS, once the linkers
 * started throwing it.
 *
 * The refusal itself is the right answer: a person must never adopt the Xero
 * customer an `Organisation` already holds. What this file pins is the half
 * nothing was watching — what the callers DO with it. Both loops it now
 * reaches were written before it existed, and both treated an unrecognised
 * error as "try again":
 *
 *  - the inbound per-member catch rethrew, which marks the inbound event FAILED
 *    and re-claims it every cycle, for ever, spending a provider call each
 *    pass;
 *  - the bulk contact sync pushed the contact id onto its retry list, which is
 *    PERSISTED into the sync cursor, so the contact was re-fetched and
 *    re-refused on every later sync with an error line in every report.
 *
 * Neither is corruption. Both are permanently-red, quota-burning states with no
 * operator remedy here, because the remedy is in Xero or in this application's
 * `Organisation` record. Both loops already had the right bucket; this is the
 * proof that the refusal now reaches it.
 *
 * The inbound half was entirely untested, which is why the gap went unseen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  applyInboundMemberContactPatch: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  getContact: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  writeXeroInboundAuditLogs: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mocks.memberFindMany },
    xeroObjectLink: { findMany: mocks.linkFindMany },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    callXeroApi: (call: () => unknown) => call(),
  };
});
vi.mock("@/lib/xero-contact-cache", () => ({
  refreshXeroContactCachesFromContact: mocks.refreshXeroContactCachesFromContact,
}));
/*
  PARTIAL, through `importOriginal`: only the writer is replaced. The refusal
  class and the two stale-participant errors the catch already recognised come
  through real, so this asserts the catch against the SAME error types
  production throws rather than against look-alikes written to agree with it.
*/
vi.mock("@/lib/xero-contact-create-recovery", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/xero-contact-create-recovery");
  return {
    ...actual,
    applyInboundMemberContactPatch: mocks.applyInboundMemberContactPatch,
  };
});
vi.mock("@/lib/xero-inbound/audit", () => ({
  writeXeroInboundAuditLogs: mocks.writeXeroInboundAuditLogs,
}));

import { XeroContactTwoHomesError } from "@/lib/xero-contact-home";
import { reconcileXeroContact } from "@/lib/xero-inbound/contact";

function twoHomes() {
  return new XeroContactTwoHomesError({
    xeroContactId: "contact-1",
    claimedBy: { kind: "MEMBER", id: "m1" },
    heldBy: { kind: "ORGANISATION", id: "org-1" },
    heldByLabel: "Tokoroa Primary School",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: { getContact: mocks.getContact } },
    tenantId: "tenant-1",
  });
  mocks.getContact.mockResolvedValue({
    body: {
      contacts: [
        {
          contactID: "contact-1",
          name: "Tokoroa Primary School",
          emailAddress: "office@school.example",
        },
      ],
    },
  });
  mocks.refreshXeroContactCachesFromContact.mockResolvedValue({
    cachedContact: { contactId: "contact-1" },
    groupMemberships: {
      contactGroupsSeen: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
    },
  });
  mocks.memberFindMany.mockResolvedValue([{ id: "m1" }]);
  mocks.linkFindMany.mockResolvedValue([]);
  /*
    `mockReset`, not just the shared `clearAllMocks`: these tests queue `…Once`
    values, `clearAllMocks` clears CALLS rather than queues, and a test that
    throws part-way leaves an unconsumed entry for the next one to pick up. That
    is how a suite starts passing or failing on test ORDER.
  */
  mocks.applyInboundMemberContactPatch.mockReset();
  mocks.applyInboundMemberContactPatch.mockResolvedValue({
    appliedFields: [],
    linked: false,
  });
});

describe("the inbound contact reconciler (#2939)", () => {
  it("treats the two-homes refusal as a terminal skip, not a failed event", async () => {
    /*
      Rethrowing marks the whole inbound event FAILED, and a failed event is
      re-claimed every cycle with nothing able to clear it — a permanently red
      row burning one provider call per pass, for a refusal that is working
      exactly as intended.
    */
    mocks.memberFindMany.mockResolvedValue([{ id: "m1" }]);
    mocks.applyInboundMemberContactPatch.mockRejectedValueOnce(twoHomes());

    const result = await reconcileXeroContact("contact-1");

    expect(result.handled).toBe(true);
    expect(result.linkedMembers).toBe(0);
    expect(result.updatedMembers).toBe(0);
  });

  it("carries on with the other members on the same contact", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    mocks.applyInboundMemberContactPatch
      .mockRejectedValueOnce(twoHomes())
      .mockResolvedValueOnce({ appliedFields: ["phoneNumber"], linked: false });

    const result = await reconcileXeroContact("contact-1");

    expect(mocks.applyInboundMemberContactPatch).toHaveBeenCalledTimes(2);
    expect(result.updatedMembers).toBe(1);
  });

  it("still fails the event for an error it has no answer to", async () => {
    // The skip is for the refusal SPECIFICALLY. A transient database error is
    // exactly what the event's retry exists for, and swallowing it would lose
    // the update instead of replaying it.
    mocks.applyInboundMemberContactPatch.mockRejectedValueOnce(
      new Error("connection terminated unexpectedly"),
    );

    await expect(reconcileXeroContact("contact-1")).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });
});
