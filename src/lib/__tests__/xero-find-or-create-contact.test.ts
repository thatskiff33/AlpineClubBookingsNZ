import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    member: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    xeroSyncOperation: {
      findFirst: vi.fn(),
      // #2623 T7: the phase-2 link transaction closes any provider-created
      // recovery whose own contact is the one it just linked.
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    // #1355: contact resolution reads the member on the GLOBAL client
    // (phase 0/1) and re-reads via the tx client (phase 2). Alias the same
    // mock fns so every existing fixture serves both phases.
    member: tx.member,
    xeroToken: {
      findFirst: vi.fn(),
    },
    /*
      #3034/#3036: `findOrCreateXeroContact` now asks which installation this is
      before it does anything. A MISSING delegate here is an UNREADABLE override,
      which resolves UNKNOWN whatever the declaration says — so without this the
      whole suite would test the refusal path and every existing assertion below
      would fail for the wrong reason. Declared inline rather than imported from a
      helper because `vi.hoisted` runs above this file's imports.
    */
    environmentSafetySettings: { findUnique: vi.fn() },
    xeroSandboxContactContainment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };

  const xeroClientInstance = {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshWithRefreshToken: vi.fn(),
    accountingApi: {
      createContacts: vi.fn(),
      getContacts: vi.fn(),
      // #3036: read back and, on a copy, contain a contact's stored address.
      getContact: vi.fn(),
      updateContact: vi.fn(),
    },
  };

  return {
    prisma,
    tx,
    xeroClientInstance,
    XeroClient: vi.fn(function MockXeroClient() {
      return xeroClientInstance;
    }),
    upsertXeroObjectLink: vi.fn(),
    startXeroSyncOperation: vi.fn(),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
    assertMemberAvailableForXeroContactChange: vi.fn(),
    lockMemberForXeroContactLink: vi.fn(
      async (db: typeof tx, memberId: string) =>
        db.member.findUnique({ where: { id: memberId } }),
    ),
    recordProviderCreatedContactPendingLocalLink: vi.fn(),
    recordXeroApiUsage: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("xero-node", () => ({
  XeroClient: mocks.XeroClient,
  Contact: class {},
  ContactGroup: class {},
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  LineItem: class {},
  LineAmountTypes: { Inclusive: "Inclusive" },
  CreditNote: {
    TypeEnum: { ACCRECCREDIT: "ACCRECCREDIT" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  Payment: class {},
  Phone: {
    PhoneTypeEnum: { MOBILE: "MOBILE" },
  },
  Address: {
    AddressTypeEnum: {
      STREET: "STREET",
      POBOX: "POBOX",
    },
  },
}));

vi.mock(
  "@/lib/xero-contact-create-recovery",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/xero-contact-create-recovery")
    >()),
    assertMemberAvailableForXeroContactChange:
      mocks.assertMemberAvailableForXeroContactChange,
    lockMemberForXeroContactLink: mocks.lockMemberForXeroContactLink,
    recordProviderCreatedContactPendingLocalLink:
      mocks.recordProviderCreatedContactPendingLocalLink,
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@/lib/pricing", () => ({
  getStayNights: vi.fn(),
}));

vi.mock("@/lib/phone", () => ({
  formatXeroPhone: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((contactId: string) => `https://go.xero.test/contact/${contactId}`),
  buildXeroInvoiceUrl: vi.fn((invoiceId: string) => `https://go.xero.test/invoice/${invoiceId}`),
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();

  return {
    ...actual,
    buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
    buildXeroPayloadHash: vi.fn(() => "payload-hash"),
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

// DB-only Xero resolution (#2079): supply the operational config and the
// token-encryption key from a stub so the token round-trip below needs no
// integration-credential DB rows.
vi.mock("@/lib/xero-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-config")>();
  return {
    ...actual,
    getOperationalXeroConfig: vi.fn().mockResolvedValue({
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUris: ["https://example.com/api/admin/xero/callback"],
      scopes: [...actual.XERO_REQUIRED_REPORT_OAUTH_SCOPES],
      httpTimeout: 10_000,
    }),
    getOperationalXeroEncryptionKey: vi
      .fn()
      .mockResolvedValue(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
  };
});

import {
  encryptToken,
  findOrCreateXeroContact,
  resetXeroRateLimitStateForTests,
} from "@/lib/xero";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";
import {
  toXeroSandboxContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";
import { XeroContactEnvironmentUnknownError } from "@/lib/xero-environment-write-gate";

describe("findOrCreateXeroContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    // Unless a test says otherwise this suite is the club's LIVE site, where
    // #3036's containment is a no-op and everything below is what it always was.
    declareEnvironmentRole("production");
    mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_existing", emailAddress: "member@example.com" }] },
    });
    mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
      body: {},
    });

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.tx.$queryRaw.mockImplementation(
      async (_strings: TemplateStringsArray, memberId: string) => [{ id: memberId }],
    );
    mocks.tx.member.findFirst.mockResolvedValue(null);
    mocks.tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.tx.xeroSyncOperation.findMany.mockResolvedValue([]);
    mocks.tx.xeroSyncOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.member.update.mockResolvedValue({ id: "mem_1", xeroContactId: "xero_new" });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.recordProviderCreatedContactPendingLocalLink.mockResolvedValue(undefined);
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: { contacts: [] },
    });
  });

  it("trusts an existing member.xeroContactId without verifying it via Xero", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe("xero_existing");

    expect(mocks.prisma.xeroToken.findFirst).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.getContacts).not.toHaveBeenCalled();
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_existing",
        xeroObjectUrl: "https://go.xero.test/contact/xero_existing",
        role: "CONTACT",
      },
      { store: mocks.tx },
    );
  });

  it("can explicitly repair an existing link by re-searching Xero and updating the member link", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_stale",
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [{ contactID: "xero_repaired" }],
      },
    });

    await expect(
      findOrCreateXeroContact("mem_1", { repairExistingLink: true })
    ).resolves.toBe("xero_repaired");

    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenCalledWith(
      "tenant_1",
      undefined,
      'EmailAddress="member@example.com"'
    );
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "mem_1" },
      data: { xeroContactId: "xero_repaired" },
    });
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_repaired",
        xeroObjectUrl: "https://go.xero.test/contact/xero_repaired",
        role: "CONTACT",
        metadata: {
          contactName: undefined,
          linkedVia: "email_match_repair",
          repairedFromXeroContactId: "xero_stale",
        },
      },
      { store: mocks.tx },
    );
  });

  it("skips the Xero email search for a walk-in placeholder owner and sends an empty email (#1935)", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_walkin",
      firstName: "Walk",
      lastName: "In",
      email: "walk-in-abc123@no-email.invalid",
      xeroContactId: null,
      phoneNumber: null,
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.tx.member.update.mockResolvedValue({ id: "mem_walkin", xeroContactId: "xero_walkin" });
    mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_walkin" }] },
    });

    await expect(findOrCreateXeroContact("mem_walkin")).resolves.toBe("xero_walkin");

    // The placeholder must never be used to search Xero (it could otherwise
    // match a real contact) and must never be sent as a real address.
    expect(mocks.xeroClientInstance.accountingApi.getContacts).not.toHaveBeenCalled();
    const createPayload =
      mocks.xeroClientInstance.accountingApi.createContacts.mock.calls[0][1];
    expect(createPayload.contacts[0].emailAddress).toBe("");
  });

  // #2859. The create branch records `linkedVia: "created"` as a POSITIVE fact,
  // and `updateXeroContact` reads it as the one case where it may write the
  // member's date of birth into the NZBN field without first observing what
  // that field holds. Without the marker, a default install (grouping mode
  // NONE, the schema default, so nothing ever writes a contact-cache row) would
  // send the date of birth at contact-create time and never again.
  //
  // It must be POSITIVE. The absence of `linkedVia` cannot stand in for it:
  // `xero-member-import.ts` links members onto pre-existing Xero contacts by
  // setting `xeroContactId` directly with no link metadata at all, which is how
  // essentially the whole live membership got its contacts, and reading that as
  // "we created it" would hand those contacts' real business numbers to the
  // birthday writer.
  it("records that THIS APP created a contact it created", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_walkin",
      firstName: "Walk",
      lastName: "In",
      email: "walk-in-abc123@no-email.invalid",
      xeroContactId: null,
      phoneNumber: null,
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.tx.member.update.mockResolvedValue({
      id: "mem_walkin",
      xeroContactId: "xero_walkin",
    });
    mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_walkin" }] },
    });

    await expect(findOrCreateXeroContact("mem_walkin")).resolves.toBe(
      "xero_walkin",
    );

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_walkin",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_walkin",
        xeroObjectUrl: "https://go.xero.test/contact/xero_walkin",
        role: "CONTACT",
        metadata: { linkedVia: "created" },
      },
      { store: mocks.tx },
    );
  });

  // #2623 T2. A walk-in placeholder owner is the DETERMINISTIC case: the Xero
  // email search is skipped by design, so nothing can produce a matched-existing
  // resolution, and the repair therefore reaches the create reservation on every
  // single attempt. That reservation used to throw XERO_CONTACT_ALREADY_LINKED
  // unconditionally whenever the member had a link, so Admin → Force sync →
  // Contact 409'd forever with nothing able to clear it.
  describe("repairing an existing link (#2623 T2)", () => {
    const walkInOwner = {
      id: "mem_walkin",
      firstName: "Walk",
      lastName: "In",
      email: "walk-in-abc123@no-email.invalid",
      xeroContactId: "xero_stale_walkin",
      phoneNumber: null,
    };

    async function connectXero() {
      mocks.prisma.xeroToken.findFirst.mockResolvedValue({
        id: "token_1",
        accessToken: await encryptToken("access"),
        refreshToken: await encryptToken("refresh"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        tenantId: "tenant_1",
      });
    }

    it("repairs a walk-in placeholder owner's link instead of 409ing forever", async () => {
      mocks.tx.member.findUnique.mockResolvedValue(walkInOwner);
      await connectXero();
      // No live contact carries this member's name, so creation is the honest
      // outcome and the reservation must be allowed to make it.
      mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
        body: { contacts: [] },
      });
      mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
        body: { contacts: [{ contactID: "xero_repaired_walkin" }] },
      });

      await expect(
        findOrCreateXeroContact("mem_walkin", { repairExistingLink: true }),
      ).resolves.toBe("xero_repaired_walkin");

      // The placeholder is still never used to search Xero by email.
      for (const call of mocks.xeroClientInstance.accountingApi.getContacts.mock
        .calls) {
        expect(String(call[2] ?? "")).not.toContain("EmailAddress");
      }
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "mem_walkin" },
        data: { xeroContactId: "xero_repaired_walkin" },
      });
      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    });

    it("re-links a live same-named contact rather than minting a duplicate", async () => {
      mocks.tx.member.findUnique.mockResolvedValue(walkInOwner);
      await connectXero();
      mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
        body: {
          contacts: [{ contactID: "xero_live_walkin", name: "Walk In" }],
        },
      });

      await expect(
        findOrCreateXeroContact("mem_walkin", { repairExistingLink: true }),
      ).resolves.toBe("xero_live_walkin");

      // Archived contacts are excluded from that search, so a genuinely dead
      // link still falls through to creation (previous test) — but a live one
      // must never become a second contact in the club's books.
      expect(
        mocks.xeroClientInstance.accountingApi.getContacts,
      ).toHaveBeenCalledWith(
        "tenant_1",
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        false,
        true,
        "Walk In",
        20,
      );
      expect(
        mocks.xeroClientInstance.accountingApi.createContacts,
      ).not.toHaveBeenCalled();
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
      expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
        expect.objectContaining({
          xeroObjectId: "xero_live_walkin",
          metadata: expect.objectContaining({
            linkedVia: "name_match_repair",
            repairedFromXeroContactId: "xero_stale_walkin",
          }),
        }),
        { store: mocks.tx },
      );
    });

    it("still refuses a create reservation for an already-linked member with no repair intent", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        ...walkInOwner,
        xeroContactId: null,
      });
      await connectXero();
      mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
        body: { contacts: [{ contactID: "xero_first" }] },
      });
      // The reservation re-reads the member under its own KEY SHARE lock: a
      // link that appeared in between must still refuse an ordinary create.
      mocks.tx.member.findUnique
        .mockResolvedValueOnce({ ...walkInOwner, xeroContactId: null })
        .mockResolvedValue(walkInOwner);

      await expect(findOrCreateXeroContact("mem_walkin")).rejects.toMatchObject({
        code: "XERO_CONTACT_ALREADY_LINKED",
      });
      expect(
        mocks.xeroClientInstance.accountingApi.createContacts,
      ).not.toHaveBeenCalled();
    });
  });

  it("links an exact Xero name match when createContacts fails with a duplicate-name validation error", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      firstName: "Jordan",
      lastName: "Hartley-Smith",
      email: "test.contact@example.org",
      xeroContactId: null,
      dateOfBirth: new Date("1987-08-30T00:00:00.000Z"),
      phoneCountryCode: "64",
      phoneAreaCode: "",
      phoneNumber: "274224115",
      streetAddressLine1: "165 Barrett Road",
      streetAddressLine2: "",
      streetCity: "New Plymouth",
      streetRegion: "Taranaki",
      streetPostalCode: "4310",
      streetCountry: "NZ",
      postalAddressLine1: "165 Barrett Road",
      postalAddressLine2: "",
      postalCity: "New Plymouth",
      postalRegion: "Taranaki",
      postalPostalCode: "4310",
      postalCountry: "NZ",
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.xeroClientInstance.accountingApi.getContacts
      .mockResolvedValueOnce({ body: { contacts: [] } })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "xero_existing_by_name",
              name: "Jordan Hartley-Smith",
              firstName: "Jordan",
              lastName: "Hartley-Smith",
            },
          ],
        },
      });
    mocks.xeroClientInstance.accountingApi.createContacts.mockRejectedValue({
      response: { statusCode: 400 },
      message: JSON.stringify({
        response: {
          statusCode: 400,
        },
        body: {
          Message: "A validation exception occurred",
          Elements: [
            {
              ValidationErrors: [
                {
                  Message:
                    "The contact name Jordan Hartley-Smith is already assigned to another contact. The contact name must be unique across all active contacts.",
                },
              ],
            },
          ],
        },
      }),
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe(
      "xero_existing_by_name"
    );

    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenNthCalledWith(
      1,
      "tenant_1",
      undefined,
      'EmailAddress="test.contact@example.org"'
    );
    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenNthCalledWith(
      2,
      "tenant_1",
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
      true,
      "Jordan Hartley-Smith",
      20
    );
    const createPayload =
      mocks.xeroClientInstance.accountingApi.createContacts.mock.calls[0][1];
    // #2859: the create payload now carries the member's date of birth in the
    // NZBN field. This line asserted its ABSENCE before #2859, which was the
    // defect rather than the contract.
    expect(createPayload.contacts[0].companyNumber).toBe("30/08/1987");
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "mem_1" },
      data: { xeroContactId: "xero_existing_by_name" },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_existing_by_name",
        responsePayload: expect.objectContaining({
          resolution: "linked_existing_contact_by_name",
          matchedBy: "name",
        }),
      })
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_existing_by_name",
        xeroObjectUrl: "https://go.xero.test/contact/xero_existing_by_name",
        role: "CONTACT",
        metadata: {
          linkedVia: "name_match",
          contactName: "Jordan Hartley-Smith",
          repairedFromXeroContactId: undefined,
        },
      },
      { store: mocks.tx },
    );
  });
});

/**
 * INV-CONFIG-005 (ENV-SAFETY 3, #3036; epic #2986): what the funnel does about
 * the address on the contact it is handing back.
 *
 * These sit in THIS file rather than a new one on purpose: this is the harness
 * that already exercises the real `findOrCreateXeroContact`, and the whole point
 * of the design is that the gate lives inside the funnel rather than in twelve
 * callers, so the funnel is where it has to be proved.
 */
describe("findOrCreateXeroContact contains the contact's address on a copy (INV-CONFIG-005)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(mocks.tx),
    );
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.tx.member.findFirst.mockResolvedValue(null);
    mocks.tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.tx.xeroSyncOperation.findMany.mockResolvedValue([]);
    mocks.tx.xeroSyncOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.recordProviderCreatedContactPendingLocalLink.mockResolvedValue(
      undefined,
    );
    mocks.prisma.xeroToken.findFirst.mockResolvedValue(null);
    mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
      null,
    );
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: { contacts: [] },
    });
    mocks.xeroClientInstance.accountingApi.updateContact.mockResolvedValue({
      body: {},
    });
  });

  async function tokenRow() {
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
  }

  it("THE RESTORED DATABASE: an already-linked member's contact is contained before the id comes back", async () => {
    // This is the case the issue exists for. Every member in a copy restored
    // from the live database is already linked, so this is the branch all twelve
    // document writers take -- and before #3036 it returned the id with no look
    // at what the contact held, while Xero went on emailing invoice reminders to
    // that address from its own servers.
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    await tokenRow();
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "xero_existing", emailAddress: "member@example.com" },
        ],
      },
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe(
      "xero_existing",
    );

    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).toHaveBeenCalledWith(
      "tenant_1",
      "xero_existing",
      {
        contacts: [
          {
            contactID: "xero_existing",
            emailAddress: toXeroSandboxContactEmail("member@example.com"),
          },
        ],
      },
      expect.stringContaining("xero_existing"),
    );
    expect(
      mocks.prisma.xeroSandboxContactContainment.upsert,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { xeroContactId: "xero_existing" },
        create: {
          xeroContactId: "xero_existing",
          containedEmail: xeroSandboxContainmentTarget("member@example.com"),
          rewroteAddress: true,
          rewrittenAt: expect.any(Date),
        },
      }),
    );
  });

  it("reuses the caller's authenticated client instead of building a second one", async () => {
    /*
      #3036 review P1-12. The steady-state path returns BEFORE
      `getAuthenticatedXeroClient()`, which is right — a proof that matches costs
      no provider call at all. But when the proof is stale or absent, containment
      then authenticated for itself, even though every document writer built a
      client two lines before calling this function. On a restored copy's first
      pass that was one extra token read plus one extra `xero.initialize()` (an
      OIDC discovery round trip, not cached) PER CONTACT.
    */
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    // Deliberately NO token row: if containment authenticates for itself, it
    // cannot, and the call fails. Passing the client is the only way through.
    mocks.prisma.xeroToken.findFirst.mockResolvedValue(null);
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "xero_existing", emailAddress: "member@example.com" },
        ],
      },
    });

    await expect(
      findOrCreateXeroContact("mem_1", {
        xero: mocks.xeroClientInstance as never,
        tenantId: "tenant_1",
      }),
    ).resolves.toBe("xero_existing");

    expect(
      mocks.xeroClientInstance.accountingApi.getContact,
    ).toHaveBeenCalledWith("tenant_1", "xero_existing");
    expect(
      mocks.prisma.xeroToken.findFirst,
      "the caller's client was supplied, so nothing here may re-authenticate",
    ).not.toHaveBeenCalled();
  });

  it("a restored link that CANNOT be contained blocks the caller, so no invoice follows", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    await tokenRow();
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });
    mocks.xeroClientInstance.accountingApi.getContact.mockRejectedValue(
      new Error("503 from Xero"),
    );

    await expect(findOrCreateXeroContact("mem_1")).rejects.toThrow(
      /cannot prove the contact is unable to reach a member/,
    );
    // And the contact still holds a real address, so nothing pretended it did
    // not.
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.prisma.xeroSandboxContactContainment.upsert,
    ).not.toHaveBeenCalled();
  });

  it("the steady state after containment costs no Xero call at all", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });
    /*
      A proof that matches AND IS FRESH. Both halves are required: the
      fingerprint alone cannot notice a change made on the Xero side, so a proof
      older than XERO_CONTAINMENT_PROOF_MAX_AGE_MS is re-verified against the
      provider (INV-CONFIG-005). `new Date()` is the frozen test clock.
    */
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue({
      containedEmail: xeroSandboxContainmentTarget("member@example.com"),
      updatedAt: new Date(),
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe(
      "xero_existing",
    );

    expect(mocks.prisma.xeroToken.findFirst).not.toHaveBeenCalled();
    expect(
      mocks.xeroClientInstance.accountingApi.getContact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).not.toHaveBeenCalled();
  });

  it("a NEW contact is created carrying the contained address, never the member's", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    await tokenRow();
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_new",
      firstName: "New",
      lastName: "Member",
      email: "member@example.com",
      xeroContactId: null,
    });
    mocks.tx.member.update.mockResolvedValue({
      id: "mem_new",
      xeroContactId: "xero_created",
    });
    mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_created" }] },
    });
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "xero_created",
            emailAddress: toXeroSandboxContactEmail("member@example.com"),
          },
        ],
      },
    });

    await expect(findOrCreateXeroContact("mem_new")).resolves.toBe(
      "xero_created",
    );

    const [, payload] =
      mocks.xeroClientInstance.accountingApi.createContacts.mock.calls[0];
    expect(payload.contacts[0].emailAddress).toBe(
      toXeroSandboxContactEmail("member@example.com"),
    );
    expect(payload.contacts[0].emailAddress).not.toContain(
      "member@example.com",
    );
    // Verified rather than assumed: the proof is written after reading Xero
    // back, and nothing had to be rewritten because the create already
    // contained it.
    expect(
      mocks.xeroClientInstance.accountingApi.getContact,
    ).toHaveBeenCalledWith("tenant_1", "xero_created");
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.prisma.xeroSandboxContactContainment.upsert,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ rewroteAddress: false }),
      }),
    );
  });

  it("a MATCHED existing contact is contained even though we did not create it", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    await tokenRow();
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      firstName: "Match",
      lastName: "Me",
      email: "member@example.com",
      xeroContactId: null,
    });
    mocks.tx.member.update.mockResolvedValue({
      id: "mem_1",
      xeroContactId: "xero_matched",
    });
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_matched" }] },
    });
    mocks.xeroClientInstance.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "xero_matched",
            emailAddress: "someone.else@example.com",
          },
        ],
      },
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe(
      "xero_matched",
    );

    // Contains what XERO holds, which on a matched contact may be somebody
    // else's address entirely.
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).toHaveBeenCalledWith(
      "tenant_1",
      "xero_matched",
      {
        contacts: [
          {
            contactID: "xero_matched",
            emailAddress: toXeroSandboxContactEmail(
              "someone.else@example.com",
            ),
          },
        ],
      },
      expect.any(String),
    );
  });

  it("UNKNOWN refuses before any provider work, and transforms nothing", async () => {
    undeclareEnvironmentRole();
    await expectEnvironmentRolePremise("UNKNOWN");
    await tokenRow();
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });

    await expect(findOrCreateXeroContact("mem_1")).rejects.toThrow(
      XeroContactEnvironmentUnknownError,
    );

    expect(
      mocks.xeroClientInstance.accountingApi.getContact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.xeroClientInstance.accountingApi.createContacts,
    ).not.toHaveBeenCalled();
    expect(
      mocks.prisma.xeroSandboxContactContainment.upsert,
    ).not.toHaveBeenCalled();
    // Nor did it fall back to the safer-looking option of containing anyway:
    // UNKNOWN is not evidence of being a copy, and rewriting the club's real
    // accounting on a guess is as wrong as emailing real members on one. It also
    // refuses BEFORE the member row is read, so nothing local happened either.
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.tx.member.findUnique).not.toHaveBeenCalled();
  });

  it("PRODUCTION is untouched: no proof read, no proof written, address verbatim", async () => {
    declareEnvironmentRole("production");
    await expectEnvironmentRolePremise("PRODUCTION");
    await tokenRow();
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_new",
      firstName: "Live",
      lastName: "Member",
      email: "member@example.com",
      xeroContactId: null,
    });
    mocks.tx.member.update.mockResolvedValue({
      id: "mem_new",
      xeroContactId: "xero_created",
    });
    mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_created" }] },
    });

    await expect(findOrCreateXeroContact("mem_new")).resolves.toBe(
      "xero_created",
    );

    const [, payload] =
      mocks.xeroClientInstance.accountingApi.createContacts.mock.calls[0];
    expect(payload.contacts[0].emailAddress).toBe("member@example.com");
    expect(
      mocks.prisma.xeroSandboxContactContainment.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      mocks.prisma.xeroSandboxContactContainment.upsert,
    ).not.toHaveBeenCalled();
    expect(
      mocks.xeroClientInstance.accountingApi.getContact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.xeroClientInstance.accountingApi.updateContact,
    ).not.toHaveBeenCalled();
  });
});
