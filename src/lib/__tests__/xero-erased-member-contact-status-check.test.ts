/**
 * #3058 — the live status check that lets the erased-member review shrink.
 *
 * THREE properties, and the first two are the whole reason the module exists at
 * this shape rather than the obvious one.
 *
 * 1. **It fetches with archived contacts INCLUDED.** Without that the check is
 *    pointless: the treasurer's archive is the event it exists to observe, and
 *    `getContacts` omits archived contacts by default. It is also precisely why
 *    the bulk contact sync can never do this job — its paging fetcher passes
 *    `includeArchived: false`, and it is the only fetcher it uses for changed
 *    contacts.
 * 2. **It writes NOTHING about a person, anywhere.** Not a contact-cache row
 *    (which would both re-import the erased person's name, email, phone,
 *    address and date of birth, and manufacture the NZBN write permission that
 *    the erasure deletes the row to remove) and not a name on the link. One
 *    field of Xero's answer is kept: the status.
 * 3. **It changes nothing in Xero.** A read, and the guard is the absence of
 *    every contact-writing call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isXeroConnected: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  fetchXeroContactsByIdsFromXero: vi.fn(),
  linkFindMany: vi.fn(),
  linkUpdate: vi.fn(),
  contactCacheUpsert: vi.fn(),
  contactCacheDeleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: mocks.linkFindMany, update: mocks.linkUpdate },
    // Present so a write to it would be RECORDED rather than crash with
    // "undefined is not a function", which reads like a harness fault instead
    // of the contract breach it is.
    xeroContactCache: {
      upsert: mocks.contactCacheUpsert,
      deleteMany: mocks.contactCacheDeleteMany,
    },
  },
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
}));
vi.mock("@/lib/xero-contact-cache", () => ({
  fetchXeroContactsByIdsFromXero: mocks.fetchXeroContactsByIdsFromXero,
}));

import {
  checkErasedMemberContactStatuses,
  ERASED_CONTACT_REVIEW_METADATA_KEY,
  readErasedContactStatusObservation,
} from "@/lib/xero-erased-member-contact-status-check";
import { XeroResyncUnavailableError } from "@/lib/xero-mismatch-resync";

/** One Xero contact as the provider returns it — details and all. */
function xeroContact(contactID: string, contactStatus: string) {
  return {
    contactID,
    contactStatus,
    name: "Jane Real-Person",
    emailAddress: "jane@example.test",
    phones: [{ phoneNumber: "5550100" }],
    addresses: [{ addressLine1: "17 Somewhere Street" }],
    companyNumber: "01/02/1970",
  };
}

describe("erased-member contact status check (#3058)", () => {
  beforeEach(() => {
    for (const stub of Object.values(mocks)) stub.mockReset();
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: {},
      tenantId: "tenant-1",
    });
    mocks.fetchXeroContactsByIdsFromXero.mockResolvedValue([]);
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.linkUpdate.mockResolvedValue({});
  });

  it("fetches with archived contacts included, which is the whole point", async () => {
    await checkErasedMemberContactStatuses(["contact-1"]);

    expect(mocks.fetchXeroContactsByIdsFromXero).toHaveBeenCalledTimes(1);
    expect(
      mocks.fetchXeroContactsByIdsFromXero.mock.calls[0][0].includeArchived,
      "Without includeArchived the check cannot see the one event it exists to " +
        "observe — a contact the treasurer archived — and the row stays listed for ever.",
    ).toBe(true);
    expect(mocks.fetchXeroContactsByIdsFromXero.mock.calls[0][0].contactIds).toEqual([
      "contact-1",
    ]);
  });

  it("keeps the status and NOTHING else off the contact", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { id: "link-1", metadata: { linkedVia: "email_match" } },
    ]);
    mocks.fetchXeroContactsByIdsFromXero.mockResolvedValue([
      xeroContact("contact-1", "ARCHIVED"),
    ]);

    await checkErasedMemberContactStatuses(["contact-1"]);

    expect(mocks.linkUpdate).toHaveBeenCalledTimes(1);
    const written = mocks.linkUpdate.mock.calls[0][0].data.metadata;
    expect(written).toEqual({
      // What the link already carried survives — the write MERGES.
      linkedVia: "email_match",
      [ERASED_CONTACT_REVIEW_METADATA_KEY]: {
        contactStatus: "ARCHIVED",
        observedAt: expect.any(String),
      },
    });

    /*
      The privacy pin, asserted on the whole serialised write rather than on
      "does not include name": the next detail Xero adds to a contact would
      pass that weaker form. Erasure removed these from this application, and a
      button on the erasure screen must not put them back.
    */
    const serialised = JSON.stringify(mocks.linkUpdate.mock.calls[0][0]);
    for (const detail of [
      "Jane",
      "Real-Person",
      "jane@example.test",
      "5550100",
      "Somewhere Street",
      "01/02/1970",
    ]) {
      expect(serialised, `the check wrote "${detail}" about an erased person`).not.toContain(
        detail,
      );
    }
  });

  it("writes no contact-cache row, which would re-import the erased details", async () => {
    mocks.linkFindMany.mockResolvedValue([{ id: "link-1", metadata: null }]);
    mocks.fetchXeroContactsByIdsFromXero.mockResolvedValue([
      xeroContact("contact-1", "ACTIVE"),
    ]);

    await checkErasedMemberContactStatuses(["contact-1"]);

    expect(mocks.contactCacheUpsert).not.toHaveBeenCalled();
    expect(mocks.contactCacheDeleteMany).not.toHaveBeenCalled();
  });

  it("only ever stamps RETIRED links, never a live member's", async () => {
    mocks.fetchXeroContactsByIdsFromXero.mockResolvedValue([
      xeroContact("contact-1", "ARCHIVED"),
    ]);

    await checkErasedMemberContactStatuses(["contact-1"]);

    expect(mocks.linkFindMany.mock.calls[0][0].where).toMatchObject({
      localModel: "Member",
      xeroObjectType: "CONTACT",
      xeroObjectId: "contact-1",
      active: false,
    });
  });

  it("counts archived and GDPR-erased alike as dealt with, and the rest as not", async () => {
    mocks.linkFindMany.mockResolvedValue([{ id: "link-1", metadata: null }]);
    mocks.fetchXeroContactsByIdsFromXero.mockResolvedValue([
      xeroContact("contact-1", "ARCHIVED"),
      xeroContact("contact-2", "GDPRREQUEST"),
      xeroContact("contact-3", "ACTIVE"),
    ]);

    const summary = await checkErasedMemberContactStatuses([
      "contact-1",
      "contact-2",
      "contact-3",
      "contact-4",
    ]);

    expect(summary.checkedContacts).toBe(4);
    expect(summary.observedContacts).toBe(3);
    expect(summary.retiredInXero).toBe(2);
    // Xero returned nothing for `contact-4` even with archived included, which
    // means merged away or gone — NOT "somebody dealt with it", so it is
    // reported separately and its row stays listed.
    expect(summary.notFoundInXero).toBe(1);
  });

  it("refuses with a 409 rather than calling Xero when it is not connected", async () => {
    mocks.isXeroConnected.mockResolvedValue(false);

    await expect(
      checkErasedMemberContactStatuses(["contact-1"]),
    ).rejects.toBeInstanceOf(XeroResyncUnavailableError);
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.fetchXeroContactsByIdsFromXero).not.toHaveBeenCalled();
  });

  it("calls Xero not at all for an empty list", async () => {
    const summary = await checkErasedMemberContactStatuses([]);

    expect(summary.checkedContacts).toBe(0);
    expect(mocks.isXeroConnected).not.toHaveBeenCalled();
    expect(mocks.fetchXeroContactsByIdsFromXero).not.toHaveBeenCalled();
  });
});

describe("reading a stamped observation back (#3058)", () => {
  it("reads the shape it wrote", () => {
    expect(
      readErasedContactStatusObservation({
        [ERASED_CONTACT_REVIEW_METADATA_KEY]: {
          contactStatus: "ARCHIVED",
          observedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
    ).toEqual({ contactStatus: "ARCHIVED", observedAt: "2026-06-20T00:00:00.000Z" });
  });

  it("reads anything else as no observation, never as a status", () => {
    /*
      `metadata` is a free-form `Json?` column with several unrelated writers,
      so a value of the wrong shape must read as "nobody has looked". The
      dangerous failure is the opposite: a malformed value read as ARCHIVED
      would retire a row nobody had dealt with, hiding real review work.
    */
    for (const metadata of [
      null,
      undefined,
      {},
      { linkedVia: "email_match" },
      { [ERASED_CONTACT_REVIEW_METADATA_KEY]: "ARCHIVED" },
      { [ERASED_CONTACT_REVIEW_METADATA_KEY]: { contactStatus: "ARCHIVED" } },
      { [ERASED_CONTACT_REVIEW_METADATA_KEY]: { observedAt: "2026-06-20" } },
      {
        [ERASED_CONTACT_REVIEW_METADATA_KEY]: {
          contactStatus: "SOMETHING_ELSE",
          observedAt: "2026-06-20T00:00:00.000Z",
        },
      },
      [{ [ERASED_CONTACT_REVIEW_METADATA_KEY]: { contactStatus: "ARCHIVED", observedAt: "x" } }],
    ]) {
      expect(readErasedContactStatusObservation(metadata as never)).toBeNull();
    }
  });
});
