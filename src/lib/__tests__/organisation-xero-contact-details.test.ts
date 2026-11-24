import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5245: the queued row that sends a school's corrected email and phone to its
 * Xero contact.
 *
 *  1. THE PAYLOAD. Exactly `contactID`, `emailAddress` and `phones` — never
 *     `name`, which #3367 forbids rewriting — with the installation's email
 *     policy applied, read from the record at send time.
 *  2. A CLEARED NUMBER IS SENT AS A BLANK PHONE, because an empty list leaves
 *     Xero's old number in place.
 *  3. SUPERSEDED AND CONTACTLESS ROWS make no provider call.
 *  4. A PROVIDER FAILURE THROWS, so the outbox records the row FAILED and the
 *     officer's Retry has something to replay.
 *  5. A CLEARED SCHOOL EMAIL FALLS BACK, exactly as on the create path: the
 *     first named contact with an address (teachers first) becomes the Xero
 *     contact's main email, and it is blank only when no contact has one. This
 *     pins kept behaviour; it is not a defect.
 */

const mocks = vi.hoisted(() => ({
  organisationFindUnique: vi.fn(),
  operationFindFirst: vi.fn(),
  linkFindFirst: vi.fn(),
  updateContact: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organisation: { findUnique: mocks.organisationFindUnique },
    xeroSyncOperation: { findFirst: mocks.operationFindFirst },
    xeroObjectLink: { findFirst: mocks.linkFindFirst },
  },
}));

// A copy of the club's site: every address reaching Xero must be contained.
vi.mock("@/lib/environment-role", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveEnvironmentRole: vi.fn(async () => ({ role: "NON_PRODUCTION" })),
}));

vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getAuthenticatedXeroClient: vi.fn(async () => ({
    xero: { accountingApi: { updateContact: mocks.updateContact } },
    tenantId: "tenant-1",
  })),
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { syncOrganisationContactDetails } from "@/lib/organisation-xero-contact-details";
import {
  applyXeroContactEmailPolicy,
  resolveXeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";

const CLAIM = { id: "op-latest", startedAt: new Date("2026-07-01T00:00:00.000Z") };

function school(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    name: "Tokoroa Primary School",
    email: "office@tokoroa.example",
    phone: "07 886 0000",
    xeroContactId: "xero-contact-1",
    contacts: [],
    ...overrides,
  };
}

async function sentContact() {
  expect(mocks.updateContact).toHaveBeenCalledTimes(1);
  const [tenantId, contactId, body] = mocks.updateContact.mock.calls[0];
  expect(tenantId).toBe("tenant-1");
  expect(contactId).toBe("xero-contact-1");
  return body.contacts[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operationFindFirst.mockResolvedValue({ id: CLAIM.id });
  mocks.organisationFindUnique.mockResolvedValue(school());
  mocks.updateContact.mockResolvedValue({ body: { contacts: [{ contactID: "xero-contact-1" }] } });
  mocks.linkFindFirst.mockResolvedValue(null);
});

describe("syncOrganisationContactDetails (#5245)", () => {
  it("sends only the contact id, the policy-applied address and the phone — never the name", async () => {
    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    const contact = await sentContact();
    expect(Object.keys(contact).sort()).toEqual(["contactID", "emailAddress", "phones"]);
    expect(contact).not.toHaveProperty("name");
    const { policy } = await resolveXeroContactEmailPolicy();
    expect(contact.emailAddress).toBe(applyXeroContactEmailPolicy(policy, "office@tokoroa.example"));
    expect(contact.emailAddress).not.toBe("office@tokoroa.example");
    expect(contact.phones).toEqual([
      expect.objectContaining({ phoneType: "MOBILE", phoneNumber: "07 886 0000" }),
    ]);
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      CLAIM,
      expect.objectContaining({ xeroObjectType: "CONTACT", xeroObjectId: "xero-contact-1" }),
    );
  });

  it("sends a cleared number as a blank phone, so Xero drops the old one", async () => {
    mocks.organisationFindUnique.mockResolvedValue(school({ phone: null }));

    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    expect((await sentContact()).phones).toEqual([
      { phoneType: "MOBILE", phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "" },
    ]);
  });

  it("sends the first teacher's address as the main email when the school's own email is cleared", async () => {
    mocks.organisationFindUnique.mockResolvedValue(
      school({
        email: null,
        contacts: [
          { member: { firstName: "Aroha", lastName: "Ngata", email: "aroha.ngata@tokoroa.example" } },
          { member: { firstName: "Ben", lastName: "Hart", email: "ben.hart@tokoroa.example" } },
        ],
      }),
    );

    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    // The details call is the first; the contact persons may follow it.
    const [, contactId, body] = mocks.updateContact.mock.calls[0];
    expect(contactId).toBe("xero-contact-1");
    const { policy } = await resolveXeroContactEmailPolicy();
    expect(body.contacts[0].emailAddress).toBe(
      applyXeroContactEmailPolicy(policy, "aroha.ngata@tokoroa.example"),
    );
  });

  it("sends a blank main email when the school's email is cleared and no teacher has one", async () => {
    mocks.organisationFindUnique.mockResolvedValue(
      school({
        email: null,
        contacts: [{ member: { firstName: "Aroha", lastName: "Ngata", email: null } }],
      }),
    );

    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    const [, , body] = mocks.updateContact.mock.calls[0];
    expect(body.contacts[0].emailAddress).toBe("");
  });

  it("gives each set of details its own idempotency key, so a retry of new details is not answered from Xero's cache", async () => {
    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });
    mocks.organisationFindUnique.mockResolvedValue(school({ email: "bursar@tokoroa.example" }));
    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    const [first, second] = mocks.updateContact.mock.calls.map((call) => call[3]);
    expect(first).not.toBe(second);
  });

  it("closes a row a later correction superseded as CANCELLED, with no provider call", async () => {
    mocks.operationFindFirst.mockResolvedValue({ id: "op-newer" });

    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(CLAIM, {
      status: "CANCELLED",
      responsePayload: { skipped: "superseded", supersededBy: "op-newer" },
    });
  });

  it("closes as a no-op for a school with no Xero contact: the first invoice's create carries the details", async () => {
    mocks.organisationFindUnique.mockResolvedValue(school({ xeroContactId: null }));

    await syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM });

    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(CLAIM, {
      responsePayload: { skipped: "no-xero-contact" },
    });
  });

  it("throws a provider failure without completing the row, so the outbox records it FAILED", async () => {
    mocks.updateContact.mockRejectedValue(new Error("Xero validation failed"));

    await expect(
      syncOrganisationContactDetails({ organisationId: "org-1", syncOperation: CLAIM }),
    ).rejects.toThrow("Xero validation failed");
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
  });
});
