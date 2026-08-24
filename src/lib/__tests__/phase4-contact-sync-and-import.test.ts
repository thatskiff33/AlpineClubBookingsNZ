import { createCipheriv } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function encryptForTest(plaintext: string) {
  const key = Buffer.from(TEST_KEY, "hex");
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

const mocks = vi.hoisted(() => {
  const accountingApi = {
    // #3036: containment reads the contact before this app overwrites it.
    getContact: vi.fn(),
    getContactGroup: vi.fn(),
    getContactGroups: vi.fn(),
    getContacts: vi.fn(),
    getInvoices: vi.fn(),
    updateContact: vi.fn(),
  };

  return {
    accountingApi,
    buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
    buildXeroPayloadHash: vi.fn(() => "payload-hash"),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
    prisma: {
      xeroToken: {
        findFirst: vi.fn(),
      },
      /*
        #3034/#3036: `updateXeroContact` asks which installation this is before
        it puts an email address on a Xero contact. A MISSING delegate here is an
        UNREADABLE override, which resolves UNKNOWN whatever the declaration
        says, and #3036 then refuses the write — so without this the suite would
        test the refusal instead of the payload it is about. Declared inline
        because `vi.hoisted` runs above this file's imports.
      */
      environmentSafetySettings: {
        findUnique: vi.fn(),
      },
      /*
        #3036: on a copy `updateXeroContact` PROVES containment before its own
        write, rather than writing and recording nothing. It has to be that way
        round: every containment row is written after reading Xero's stored value
        back, and after this function's own write the value read back is the
        contained address it just sent — so a row written afterwards would say
        "nothing was overwritten" about a real overwrite, and the operator
        surface would report a reassuring zero.
      */
      xeroSandboxContactContainment: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      xeroSyncCursor: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      xeroContactCache: {
        upsert: vi.fn(),
        findMany: vi.fn(),
        // #2859: `updateXeroContact` reads what Xero is known to hold in the
        // NZBN field before deciding whether it may write a date of birth there.
        findUnique: vi.fn(),
      },
      // #2859: and it asks whether THIS APP created the contact, which is the
      // one case where "never cached" is still safe to write into.
      xeroObjectLink: {
        findFirst: vi.fn(),
      },
      xeroContactGroupCache: {
        deleteMany: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      xeroContactGroupMembershipCache: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
        createMany: vi.fn(),
        updateMany: vi.fn(),
      },
      member: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      passwordResetToken: {
        create: vi.fn(),
      },
      familyGroupMember: {
        findFirst: vi.fn(),
        create: vi.fn(),
        createMany: vi.fn(),
      },
      familyGroup: {
        create: vi.fn(),
      },
      xeroAccountMapping: {
        findUnique: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
      // #2623 T7: the inbound contact patch closes any provider-created create
      // recovery whose own contact is the canonical link it just landed.
      xeroSyncOperation: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        // #2859: a contact-link repair re-persists the operation's request
        // payload against the repaired contact before retrying the write.
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    recordXeroApiUsage: vi.fn(),
    sanitizeForJson: vi.fn((value: unknown) => value),
    startXeroSyncOperation: vi.fn(),
    upsertXeroObjectLink: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/pricing", () => ({
  getStayNights: vi.fn(),
}));
vi.mock("@/lib/phone", () => ({
  formatXeroPhone: vi.fn((phone: { phoneNumber?: string | null }) => phone.phoneNumber ?? null),
}));
vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));
vi.mock("@/lib/xero-error-shape", () => ({
  getXeroErrorHeader: vi.fn(
    (error: { response?: { headers?: Record<string, string> } }, header: string) =>
      error?.response?.headers?.[header]
  ),
  getXeroErrorBodyMessage: vi.fn(() => undefined),
  getXeroErrorStatusCode: vi.fn(
    (error: { response?: { statusCode?: number } }) => error?.response?.statusCode
  ),
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((id: string) => `https://xero.test/contacts/${id}`),
  buildXeroInvoiceUrl: vi.fn((id: string) => `https://xero.test/invoices/${id}`),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: mocks.buildXeroIdempotencyKey,
  buildXeroPayloadHash: mocks.buildXeroPayloadHash,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  sanitizeForJson: mocks.sanitizeForJson,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));
vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("placeholder-hash"),
}));
vi.mock("xero-node", () => ({
  XeroClient: class {
    accountingApi = mocks.accountingApi;
    initialize = vi.fn().mockResolvedValue(undefined);
    setTokenSet = vi.fn();
    refreshWithRefreshToken = vi.fn();
  },
  Contact: class {},
  ContactGroup: { StatusEnum: { ACTIVE: "ACTIVE" } },
  Invoice: {
    StatusEnum: {
      PAID: "PAID",
      AUTHORISED: "AUTHORISED",
      SUBMITTED: "SUBMITTED",
    },
  },
  LineItem: class {},
  LineAmountTypes: {},
  CreditNote: class {},
  Payment: class {},
  Phone: { PhoneTypeEnum: { MOBILE: "MOBILE" } },
  Address: { AddressTypeEnum: { STREET: "STREET", POBOX: "POBOX" } },
}));

// DB-only Xero resolution (#2079): the token key must equal TEST_KEY so the
// encryptForTest fixtures round-trip, and the operational config must resolve
// without integration-credential DB rows.
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
  findPotentialXeroContactsForMember,
  importMembersFromXeroGroups,
  refreshXeroContactGroupCache,
  syncContactsFromXero,
  updateXeroContact,
} from "@/lib/xero";
import {
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
  CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
} from "@/lib/xero-contact-cache";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
} from "@/lib/__tests__/helpers/environment-role";
import { toXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";

describe("Phase 4 contact sync and cached import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("XERO_ENCRYPTION_KEY", TEST_KEY);
    // The club's LIVE site, where #3036's containment is the identity function
    // and every payload below is what it always was.
    declareEnvironmentRole("production");
    mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);

    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptForTest("access-token"),
      refreshToken: encryptForTest("refresh-token"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      tenantId: "tenant_1",
    });
    mocks.prisma.xeroSyncCursor.upsert.mockResolvedValue({});
    mocks.prisma.xeroContactCache.upsert.mockResolvedValue({});
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue(null);
    // Default: no link metadata, i.e. NOT a contact this app is known to have
    // created. That is the conservative reading, and it is the one the live
    // site's imported contacts present.
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.prisma.xeroContactGroupCache.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.xeroContactGroupCache.findMany.mockResolvedValue([]);
    mocks.prisma.xeroContactGroupCache.upsert.mockResolvedValue({});
    mocks.prisma.xeroContactGroupCache.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([]);
    mocks.prisma.xeroContactGroupMembershipCache.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.xeroContactGroupMembershipCache.createMany.mockResolvedValue({ count: 0 });
    mocks.prisma.xeroContactGroupMembershipCache.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.member.update.mockResolvedValue({});
    mocks.prisma.auditLog.create.mockResolvedValue({});
    mocks.prisma.member.create.mockResolvedValue({
      id: "member_new",
      email: "new@example.com",
    });
    mocks.prisma.member.findUnique.mockResolvedValue(null);
    mocks.prisma.$executeRaw.mockResolvedValue(1);
    mocks.prisma.member.findMany.mockResolvedValue([]);
    mocks.prisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mocks.prisma.familyGroupMember.create.mockResolvedValue({});
    mocks.prisma.familyGroupMember.createMany.mockResolvedValue({});
    mocks.prisma.familyGroup.create.mockResolvedValue({ id: "family_1" });
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mocks.prisma) => Promise<unknown>) =>
        callback(mocks.prisma)
    );
    mocks.recordXeroApiUsage.mockResolvedValue(undefined);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.accountingApi.getContactGroup.mockReset();
    mocks.accountingApi.getContactGroups.mockReset();
    mocks.accountingApi.getContacts.mockReset();
    mocks.accountingApi.getInvoices.mockReset();
    mocks.accountingApi.updateContact.mockResolvedValue({
      body: { contacts: [{ contactID: "contact_1" }] },
    });
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
      null,
    );
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
    mocks.accountingApi.getContact.mockResolvedValue({
      body: { contacts: [{ contactID: "contact_1", emailAddress: "" }] },
    });
  });

  /*
    INV-CONFIG-005 (ENV-SAFETY 3, #3036). `updateXeroContact` is the third
    email-carrying Xero contact writer — a member editing their profile, an
    admin editing their record, a confirmed email change — and it does not go
    through the funnel, so it needs its own proof.
  */
  it("on a COPY, a contact update carries the contained address and never the member's", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      phoneCountryCode: "64",
      phoneAreaCode: "21",
      phoneNumber: "1234567",
    });

    await updateXeroContact(
      "contact_1",
      undefined,
      { localModel: "Member", localId: "member_1", preserveXeroName: false },
    );

    const hashPayload = (mocks.buildXeroPayloadHash.mock.calls as unknown as Array<
      [{ contacts: Array<Record<string, unknown>> }]
    >)[0][0];
    expect(hashPayload.contacts[0].emailAddress).toBe(
      toXeroSandboxContactEmail("jane@example.com"),
    );
    expect(hashPayload.contacts[0].emailAddress).not.toBe("jane@example.com");
    // The name, phone and address still travel: containment is about the
    // ADDRESS, and a copy that stopped syncing everything else would stop
    // behaving like production.
    expect(hashPayload.contacts[0]).toEqual(
      expect.objectContaining({ name: "Jane Doe", firstName: "Jane" }),
    );
    const [, , sentPayload] = mocks.accountingApi.updateContact.mock
      .calls[0] as unknown as [string, string, { contacts: Array<Record<string, unknown>> }];
    expect(sentPayload.contacts[0].emailAddress).toBe(
      toXeroSandboxContactEmail("jane@example.com"),
    );
    /*
      AND THE PROOF IS RECORDED (#3036 review P0-3b). This path is reachable with
      no invoice anywhere near it, and it overwrites what Xero holds. Recording
      nothing let the operator surface say "no Xero contact has been touched yet"
      while this installation had already edited real accounting records.
    */
    expect(mocks.prisma.xeroSandboxContactContainment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { xeroContactId: "contact_1" } }),
    );
  });

  it("on a COPY, a contact update whose contact holds a REAL address records the overwrite", async () => {
    /*
      The under-count this closes. Containment runs BEFORE the update, so the
      read-back still sees the deliverable address that was really there — and
      `rewroteAddress` is therefore a measurement rather than a guess. Recording
      after the update would have read back the contained address this function
      just sent and concluded that nothing was overwritten.
    */
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
    });
    mocks.accountingApi.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact_1", emailAddress: "jane@example.com" },
        ],
      },
    });

    await updateXeroContact("contact_1", undefined, {
      localModel: "Member",
      localId: "member_1",
      preserveXeroName: false,
    });

    expect(mocks.prisma.xeroSandboxContactContainment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ rewroteAddress: true }),
      }),
    );
  });

  it("on a COPY, a contact update that cannot prove containment writes nothing to Xero", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
    });
    mocks.accountingApi.getContact.mockRejectedValue(new Error("503 from Xero"));

    await expect(
      updateXeroContact("contact_1", undefined, {
        localModel: "Member",
        localId: "member_1",
        preserveXeroName: false,
      }),
    ).rejects.toThrow(/cannot prove the contact is unable to reach a member/);
    expect(mocks.accountingApi.updateContact).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalled();
  });

  it("REFUSES a contact update when nobody has said what this installation is", async () => {
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "");
    await expectEnvironmentRolePremise("UNKNOWN");
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
    });

    await expect(
      updateXeroContact("contact_1", undefined, {
        localModel: "Member",
        localId: "member_1",
        preserveXeroName: false,
      }),
    ).rejects.toThrow(/APP_ENVIRONMENT_ROLE/);

    expect(mocks.accountingApi.updateContact).not.toHaveBeenCalled();
    // And it refuses before a reservation is even opened, so nothing local is
    // left half-done either.
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("builds member contact updates from the locked row instead of stale caller PII", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      phoneCountryCode: "64",
      phoneAreaCode: "21",
      phoneNumber: "1234567",
    });
    await updateXeroContact(
      "contact_1",
      {
        firstName: "Stale",
        lastName: "Snapshot",
        email: "stale@example.com",
        phoneCountryCode: "1",
        phoneAreaCode: "555",
        phoneNumber: "0000000",
      },
      {
        localModel: "Member",
        localId: "member_1",
        preserveXeroName: false,
      }
    );

    const hashPayload = (mocks.buildXeroPayloadHash.mock.calls as unknown as Array<
      [{ contacts: Array<Record<string, unknown>> }]
    >)[0][0];
    expect(hashPayload.contacts[0]).toEqual(
      expect.objectContaining({
        contactID: "contact_1",
        name: "Jane Doe",
        firstName: "Jane",
        lastName: "Doe",
        emailAddress: "jane@example.com",
        phones: [
          {
            phoneType: "MOBILE",
            phoneCountryCode: "64",
            phoneAreaCode: "21",
            phoneNumber: "1234567",
          },
        ],
      })
    );
    // #2859: this member's locked row has no date of birth, so no
    // `companyNumber` key is emitted at all — never `""`, which would blank
    // whatever the Xero contact holds in the NZBN field.
    expect(hashPayload.contacts[0]).not.toHaveProperty("companyNumber");
    expect(hashPayload.contacts[0]).not.toEqual(
      expect.objectContaining({ emailAddress: "stale@example.com" }),
    );
    expect(mocks.accountingApi.updateContact).toHaveBeenCalledWith(
      "tenant_1",
      "contact_1",
      hashPayload,
      "contact:contact_1:update:payload-hash:v2"
    );
  });

  // #2859 defect A: the write did not exist. `buildContact` set contactID,
  // emailAddress, phones, addresses and the name fields and NOTHING else, so a
  // member's date of birth never reached Xero's NZBN field on any path — which
  // is exactly what the club reported. These two tests are the write, and the
  // guard that stops it destroying somebody's real business number.
  it("sends the locked member's date of birth as the Xero company number", async () => {
    // The cache row exists and says the NZBN field is empty, so this app's
    // value wins. The absent-cache-row case is the test below, and it is the
    // opposite outcome.
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      companyNumber: null,
    });
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      // A date-only value at UTC midnight — what every correct writer stores
      // and what the #2859 migration re-encodes the imported rows to.
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    });

    await updateXeroContact(
      "contact_1",
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      { localModel: "Member", localId: "member_1", preserveXeroName: false },
    );

    const sent = (mocks.accountingApi.updateContact.mock.calls as unknown as Array<
      [string, string, { contacts: Array<Record<string, unknown>> }, string]
    >)[0][2];
    // `dd/mm/yyyy`, the exact shape the import side has always read back — and
    // the day the member was actually born, not the evening before it.
    expect(sent.contacts[0].companyNumber).toBe("15/06/1985");
    // The date of birth is taken from the LOCKED row, not from the caller's
    // snapshot, like every other field on this payload.
    expect(mocks.prisma.xeroContactCache.findUnique).toHaveBeenCalledWith({
      where: { contactId: "contact_1" },
      select: { companyNumber: true },
    });
  });

  it("sends nothing at all when no cached contact says what the NZBN field holds", async () => {
    // The blocker a review found here. `findOrCreateXeroContact` links a member
    // onto a PRE-EXISTING Xero contact by email match (and failing that by
    // exact-name match), and nothing on that path writes a contact-cache row —
    // `syncContactGroupsBestEffort` returns before it fetches the contact when
    // grouping is off. So "no cache row" is not "a contact this app created and
    // therefore an empty field": it is routinely a contact somebody else made,
    // possibly carrying a real New Zealand Business Number. Writing a birthday
    // over it would destroy a value this system cannot recover. The date of
    // birth goes out on the next update, once the contact has been cached.
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue(null);
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    });

    await updateXeroContact(
      "contact_1",
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      { localModel: "Member", localId: "member_1", preserveXeroName: false },
    );

    const sent = (mocks.accountingApi.updateContact.mock.calls as unknown as Array<
      [string, string, { contacts: Array<Record<string, unknown>> }, string]
    >)[0][2];
    expect(sent.contacts[0]).not.toHaveProperty("companyNumber");
    // The rest of the update still goes as normal — this drops one field, not
    // the write.
    expect(sent.contacts[0].emailAddress).toBe("jane@example.com");
  });

  it("still sends it to a contact THIS APP created, even with no cache row", async () => {
    // The narrowing the cache rule would otherwise cause, and it is the common
    // case rather than an edge one. `syncManagedXeroContactGroupForMember` is
    // the only create-time cache writer, and it short-circuits before any Xero
    // call when the grouping mode is `NONE` — the schema default. So on a
    // default install with no inbound cron, no cache row is ever written, and a
    // cache-only rule would send the date of birth at contact-create time and
    // then never again, silently, however many times an administrator corrected
    // it.
    //
    // A contact this app created is the one case where "never observed" is
    // still safe: it held nothing when it was made, and nothing but this app's
    // own writes has reached that field since.
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
      metadata: { linkedVia: "created" },
    });
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    });

    await updateXeroContact(
      "contact_1",
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      { localModel: "Member", localId: "member_1", preserveXeroName: false },
    );

    const sent = (mocks.accountingApi.updateContact.mock.calls as unknown as Array<
      [string, string, { contacts: Array<Record<string, unknown>> }, string]
    >)[0][2];
    expect(sent.contacts[0].companyNumber).toBe("15/06/1985");
  });

  it("does NOT treat a matched contact as one this app created", async () => {
    // The symmetric half, and why the marker has to be POSITIVE. A contact the
    // app merely linked carries `linkedVia: "email_match"` (or `name_match`),
    // and `xero-member-import.ts` links pre-existing contacts with NO link
    // metadata at all — which is how essentially the whole live membership got
    // its contacts. Neither may be read as "we created it", because both may
    // hold a real New Zealand Business Number nobody has looked at.
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue(null);
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    });

    for (const metadata of [
      { linkedVia: "email_match" },
      { linkedVia: "name_match" },
      { linkedVia: "email_match_repair" },
      // The imported-contact shape: a link row with nothing on it.
      null,
      {},
    ]) {
      mocks.accountingApi.updateContact.mockClear();
      mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue(
        metadata === null ? null : { metadata },
      );

      await updateXeroContact(
        "contact_1",
        { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
        { localModel: "Member", localId: "member_1", preserveXeroName: false },
      );

      const sent = (mocks.accountingApi.updateContact.mock.calls as unknown as Array<
        [string, string, { contacts: Array<Record<string, unknown>> }, string]
      >)[0][2];
      expect(
        sent.contacts[0],
        `${JSON.stringify(metadata)} must not be read as "this app created it"`,
      ).not.toHaveProperty("companyNumber");
    }
  });

  it("refuses to overwrite a real NZBN with a date of birth", async () => {
    // The NZBN field is not this club's private property: an administrator may
    // have typed a genuine New Zealand Business Number into it. A date of birth
    // does not get to destroy the club's accounting data, so the write is
    // dropped and the rest of the update goes as normal.
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      companyNumber: "9429041234567",
    });
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    });

    await updateXeroContact(
      "contact_1",
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      { localModel: "Member", localId: "member_1", preserveXeroName: false },
    );

    const sent = (mocks.accountingApi.updateContact.mock.calls as unknown as Array<
      [string, string, { contacts: Array<Record<string, unknown>> }, string]
    >)[0][2];
    expect(sent.contacts[0]).not.toHaveProperty("companyNumber");
    expect(sent.contacts[0].emailAddress).toBe("jane@example.com");
  });

  it("does not carry one contact's NZBN judgement onto a repaired contact", async () => {
    // #2859. `retryXeroWriteWithContactRepair` rebuilds this payload against a
    // DIFFERENT contact when it repairs a stale link, and the cache reading was
    // taken for the ORIGINAL one. Sending the date of birth anyway would judge
    // the repaired contact's NZBN field by another contact's contents, and could
    // overwrite a real business number nobody has looked at. The date of birth
    // is simply not sent to a contact this call did not read.
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      companyNumber: null,
    });
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    });
    mocks.prisma.member.findFirst.mockResolvedValue(null);
    // Xero rejects the stale contact reference once, then accepts the repaired
    // one. The message is the shape `isRetryableXeroContactReferenceError` reads.
    mocks.accountingApi.updateContact
      .mockRejectedValueOnce(
        Object.assign(new Error("Contact not found"), {
          response: {
            statusCode: 404,
            body: {
              Elements: [
                {
                  ValidationErrors: [
                    { Message: "Contact not found for ContactID contact_1" },
                  ],
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValue({ body: { contacts: [{ contactID: "contact_2" }] } });
    // The repair re-resolves the member's contact by email onto a different id.
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "contact_2", name: "Jane Doe" }] },
    });

    await updateXeroContact(
      "contact_1",
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      { localModel: "Member", localId: "member_1", preserveXeroName: false },
    );

    const calls = mocks.accountingApi.updateContact.mock.calls as unknown as Array<
      [string, string, { contacts: Array<Record<string, unknown>> }, string]
    >;
    expect(calls).toHaveLength(2);
    // The first attempt, against the contact whose NZBN field WAS read, carries it.
    expect(calls[0][1]).toBe("contact_1");
    expect(calls[0][2].contacts[0].companyNumber).toBe("15/06/1985");
    // The retry, against a contact nobody has read, does not.
    expect(calls[1][1]).toBe("contact_2");
    expect(calls[1][2].contacts[0]).not.toHaveProperty("companyNumber");
  });

  // INV-PRIV-011 (#2683 review finding 2). Xero's API REQUIRES `Name` on a
  // contact, so the request that goes to Xero has to carry the member's full
  // name — but the very same object was handed to startXeroSyncOperation, so it
  // was also written into XeroSyncOperation.requestPayload and kept there.
  // firstName/lastName/emailAddress/address lines are stripped by the redactor;
  // `name` is not, and cannot be, because `name` also keys lodges, rooms and
  // Xero contact groups that the admin panel reads back out of these payloads.
  it("sends Xero the contact name but does not store it on the operation", async () => {
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
    });

    await updateXeroContact(
      "contact_1",
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      { localModel: "Member", localId: "member_1", preserveXeroName: false }
    );

    const sent = (mocks.accountingApi.updateContact.mock.calls as unknown as Array<
      [string, string, { contacts: Array<Record<string, unknown>> }, string]
    >)[0][2];
    expect(sent.contacts[0].name).toBe("Jane Doe");

    const stored = (mocks.startXeroSyncOperation.mock.calls as unknown as Array<
      [{ requestPayload: { contacts: Array<Record<string, unknown>> } }]
    >)[0][0].requestPayload;
    expect(stored.contacts[0]).not.toHaveProperty("name");
    // Everything else the operation needs to be replayable is still there.
    expect(stored.contacts[0]).toEqual(
      expect.objectContaining({ contactID: "contact_1", firstName: "Jane" })
    );

    // The idempotency key is computed from the OUTBOUND request, so stripping
    // the stored copy cannot change an operation's identity.
    const hashed = (mocks.buildXeroPayloadHash.mock.calls as unknown as Array<
      [{ contacts: Array<Record<string, unknown>> }]
    >)[0][0];
    expect(hashed.contacts[0].name).toBe("Jane Doe");
  });

  it("closes a committed member-update reservation when Xero authentication fails", async () => {
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
    });
    mocks.prisma.xeroToken.findFirst.mockRejectedValueOnce(
      new Error("authentication unavailable"),
    );

    await expect(
      updateXeroContact(
        "contact_1",
        { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
        { localModel: "Member", localId: "member_1" },
      ),
    ).rejects.toThrow("authentication unavailable");

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    expect(mocks.accountingApi.updateContact).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({ message: "authentication unavailable" }),
    );
  });

  it("repairs missing contact snapshots when refreshing Xero contact groups", async () => {
    mocks.accountingApi.getContactGroups.mockResolvedValue({
      body: {
        contactGroups: [
          {
            contactGroupID: "group_1",
            name: "Adults",
            status: "ACTIVE",
          },
        ],
      },
    });
    mocks.accountingApi.getContactGroup.mockResolvedValue({
      body: {
        contactGroups: [
          {
            contacts: [
              { contactID: "contact_missing", name: "Missing Person" },
              { contactID: "contact_cached", name: "Cached Person" },
            ],
          },
        ],
      },
    });
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      { contactId: "contact_cached" },
    ]);
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_missing",
            name: "Missing Person",
            firstName: "Missing",
            lastName: "Person",
            emailAddress: "missing@example.com",
            contactStatus: "ACTIVE",
          },
        ],
      },
    });

    const result = await refreshXeroContactGroupCache({
      repairMissingContactCache: true,
    });

    expect(result).toEqual([
      { id: "group_1", name: "Adults", contactCount: 2 },
    ]);
    expect(mocks.accountingApi.getContacts).toHaveBeenCalledWith(
      "tenant_1",
      undefined,
      undefined,
      undefined,
      ["contact_missing"],
      undefined,
      true
    );
    expect(mocks.prisma.xeroContactCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId: "contact_missing" },
        create: expect.objectContaining({
          contactId: "contact_missing",
          emailAddress: "missing@example.com",
        }),
        update: expect.objectContaining({
          contactId: "contact_missing",
          emailAddress: "missing@example.com",
        }),
      })
    );
    expect(mocks.prisma.xeroContactGroupMembershipCache.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          contactGroupId: "group_1",
          contactId: "contact_missing",
          contactName: "Missing Person",
        }),
        expect.objectContaining({
          contactGroupId: "group_1",
          contactId: "contact_cached",
          contactName: "Cached Person",
        }),
      ]),
      skipDuplicates: true,
    });
  });

  it("records a dedicated full-refresh cursor (separate from the incremental cache cursor) so the members-page hint tracks whole-snapshot staleness", async () => {
    mocks.accountingApi.getContactGroups.mockResolvedValue({
      body: {
        contactGroups: [
          { contactGroupID: "group_1", name: "Adults", status: "ACTIVE" },
        ],
      },
    });
    mocks.accountingApi.getContactGroup.mockResolvedValue({
      body: { contactGroups: [{ contacts: [] }] },
    });

    await refreshXeroContactGroupCache();

    const upsertResources = mocks.prisma.xeroSyncCursor.upsert.mock.calls.map(
      (call) => call[0].where.resourceType_scope.resourceType
    );
    // The existing incremental cache cursor is still written, untouched...
    expect(upsertResources).toContain(CONTACT_GROUP_CACHE_CURSOR_RESOURCE);
    // ...and the new full-refresh cursor is written too.
    expect(upsertResources).toContain(
      CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE
    );

    const fullRefreshUpsert = mocks.prisma.xeroSyncCursor.upsert.mock.calls.find(
      (call) =>
        call[0].where.resourceType_scope.resourceType ===
        CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE
    )?.[0];
    expect(fullRefreshUpsert?.create?.lastSuccessfulSyncAt).toBeInstanceOf(Date);
    expect(fullRefreshUpsert?.update?.lastSuccessfulSyncAt).toBeInstanceOf(Date);
  });

  it("uses the contact sync cursor and skips first-invoice lookups in the default sync path", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: new Date("2026-04-14T10:00:00.000Z"),
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {
        retryContactIds: ["contact_retry"],
      },
    });
    mocks.accountingApi.getContacts
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              name: "John Smith",
              emailAddress: "john@example.com",
              phones: [
                {
                  phoneType: "MOBILE",
                  phoneCountryCode: "64",
                  phoneAreaCode: "27",
                  phoneNumber: "1112222",
                },
              ],
              addresses: [
                {
                  addressType: "STREET",
                  addressLine1: "1 Alpine Way",
                  city: "Wanaka",
                  region: "Otago",
                  postalCode: "9305",
                  country: "NZ",
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_retry",
              name: "Retry Contact",
            },
          ],
        },
      });
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member_1",
        firstName: "John",
        lastName: "Smith",
        xeroContactId: null,
        joinedDate: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      })
      .mockResolvedValueOnce(null);
    const unlinkedMember = {
      id: "member_1",
      firstName: "John",
      lastName: "Smith",
      email: "john.smith@example.com",
      passwordHash: "not-deleted",
      xeroContactId: null,
      joinedDate: null,
      dateOfBirth: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    };
    mocks.prisma.member.findUnique
      .mockResolvedValueOnce(unlinkedMember)
      .mockResolvedValueOnce(unlinkedMember)
      .mockResolvedValue({
        ...unlinkedMember,
        xeroContactId: "contact_1",
      });

    const report = await syncContactsFromXero();

    expect(report.errors).toEqual([]);
    expect(report.total).toBe(2);
    expect(report.updated).toHaveLength(1);
    expect(report.skippedNoEmail).toEqual([
      { name: "Retry Contact", xeroContactId: "contact_retry" },
    ]);
    expect(mocks.accountingApi.getInvoices).not.toHaveBeenCalled();

    const firstGetContactsCall = mocks.accountingApi.getContacts.mock.calls[0];
    expect(firstGetContactsCall[1]?.toISOString()).toBe(
      "2026-04-14T09:58:00.000Z"
    );
    expect(firstGetContactsCall[5]).toBe(1);

    const retryGetContactsCall = mocks.accountingApi.getContacts.mock.calls[1];
    expect(retryGetContactsCall[4]).toEqual(["contact_retry"]);

    const updatedMemberCall = mocks.prisma.member.update.mock.calls[0][0];
    expect(updatedMemberCall).toEqual({
      where: { id: "member_1" },
      data: expect.objectContaining({
        xeroContactId: "contact_1",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "1112222",
        streetAddressLine1: "1 Alpine Way",
      }),
      select: { id: true },
    });
    expect(updatedMemberCall.data).not.toHaveProperty("joinedDate");
    expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.contact.synced_to_member",
        subjectMemberId: "member_1",
        entityType: "Member",
        entityId: "member_1",
        category: "xero",
        metadata: expect.objectContaining({
          xeroContactId: "contact_1",
          changedFields: expect.arrayContaining([
            "xeroContactLink",
            "phone",
            "streetAddress",
          ]),
        }),
      }),
    });
    expect(
      JSON.stringify(mocks.prisma.auditLog.create.mock.calls[0][0].data.metadata)
    ).not.toContain("1112222");

    expect(mocks.prisma.xeroSyncCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          resourceType: "CONTACT_SYNC",
          metadata: expect.objectContaining({
            changedContactCount: 1,
            retryContactIds: [],
          }),
        }),
      })
    );
  });

  it("selectively refreshes cached contact-group memberships from changed contacts", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: new Date("2026-04-14T10:00:00.000Z"),
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            name: "Group Refresh Contact",
            emailAddress: "groups@example.com",
            contactGroups: [
              {
                contactGroupID: "group_existing",
                name: "Existing Group",
                status: "ACTIVE",
              },
              {
                contactGroupID: "group_new",
                name: "New Group",
                status: "ACTIVE",
              },
            ],
          },
        ],
      },
    });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_old" },
      { contactGroupId: "group_existing" },
    ]);
    mocks.prisma.xeroContactGroupCache.findMany.mockResolvedValue([
      {
        contactGroupId: "group_existing",
        name: "Existing Group",
      },
    ]);
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await syncContactsFromXero();

    expect(mocks.prisma.xeroContactGroupMembershipCache.deleteMany).toHaveBeenCalledWith({
      where: {
        contactId: "contact_1",
        contactGroupId: { in: ["group_old"] },
      },
    });
    expect(mocks.prisma.xeroContactGroupMembershipCache.updateMany).toHaveBeenCalledWith({
      where: {
        contactId: "contact_1",
        contactGroupId: { in: ["group_existing"] },
      },
      data: expect.objectContaining({
        contactName: "Group Refresh Contact",
      }),
    });
    expect(mocks.prisma.xeroContactGroupMembershipCache.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          contactGroupId: "group_new",
          contactId: "contact_1",
          contactName: "Group Refresh Contact",
        }),
      ],
      skipDuplicates: true,
    });
    expect(mocks.prisma.xeroContactGroupCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactGroupId: "group_existing" },
        update: expect.objectContaining({
          name: "Existing Group",
          status: "ACTIVE",
        }),
      })
    );
    expect(mocks.prisma.xeroContactGroupCache.updateMany).toHaveBeenCalledWith({
      where: {
        contactGroupId: { in: ["group_old"] },
        contactCount: { gt: 0 },
      },
      data: expect.objectContaining({
        contactCount: { decrement: 1 },
      }),
    });
    expect(mocks.prisma.xeroContactGroupCache.updateMany).toHaveBeenCalledWith({
      where: {
        contactGroupId: { in: ["group_new"] },
      },
      data: expect.objectContaining({
        contactCount: { increment: 1 },
      }),
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 15000 }
    );
    expect(mocks.prisma.xeroSyncCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          resourceType: "CONTACT_GROUP_CACHE",
          scope: "default",
        }),
        update: expect.objectContaining({
          lastSuccessfulSyncAt: expect.any(Date),
        }),
      })
    );
  });

  it("repairs a linked Xero contact when first and last names are reversed", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            name: "TestLast, TestFirst",
            firstName: "TestLast",
            lastName: "TestFirst",
            emailAddress: "reversed-name@example.com",
          },
        ],
      },
    });
    mocks.accountingApi.updateContact.mockResolvedValue({
      body: { contacts: [{ contactID: "contact_1" }] },
    });
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_1",
      firstName: "TestFirst",
      lastName: "TestLast",
      email: "reversed-name@example.com",
      active: true,
      xeroContactId: "contact_1",
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "TestFirst",
      lastName: "TestLast",
      email: "reversed-name@example.com",
      passwordHash: "not-deleted",
      xeroContactId: "contact_1",
      joinedDate: null,
      dateOfBirth: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });

    const report = await syncContactsFromXero();

    expect(report.skippedNameMismatch).toEqual([]);
    expect(report.updated).toEqual([
      {
        name: "TestFirst TestLast",
        memberId: "member_1",
        xeroContactId: "contact_1",
        changes: ["Xero contact name set to TestFirst TestLast"],
      },
    ]);
    expect(mocks.accountingApi.updateContact).toHaveBeenCalledWith(
      "tenant_1",
      "contact_1",
      {
        contacts: [
          expect.objectContaining({
            contactID: "contact_1",
            name: "TestFirst TestLast",
            firstName: "TestFirst",
            lastName: "TestLast",
          }),
        ],
      },
      "contact:contact_1:repair-name-order:payload-hash:v2"
    );
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
      }),
      expect.objectContaining({ store: mocks.prisma }),
    );
  });

  it("does not auto-link a member when the email matches but the names differ", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_mismatch",
            name: "John Smith",
            firstName: "John",
            lastName: "Smith",
            emailAddress: "shared@example.com",
          },
        ],
      },
    });
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member_1",
        firstName: "Jane",
        lastName: "Doe",
        email: "shared@example.com",
        active: true,
        xeroContactId: null,
        joinedDate: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      });

    const report = await syncContactsFromXero();

    expect(report.updated).toEqual([]);
    expect(report.skippedNameMismatch).toEqual([
      {
        memberId: "member_1",
        memberName: "Jane Doe",
        memberEmail: "shared@example.com",
        xeroContactId: "contact_mismatch",
        xeroContactName: "John Smith",
        xeroContactEmail: "shared@example.com",
        reasons: ["First name differs", "Last name differs"],
      },
    ]);
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
  });

  it("does not report a name mismatch for an email match that is already linked to another Xero contact", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_duplicate_email",
            name: "John Smith",
            firstName: "John",
            lastName: "Smith",
            emailAddress: "shared@example.com",
          },
        ],
      },
    });
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member_1",
        firstName: "Jane",
        lastName: "Doe",
        email: "shared@example.com",
        active: true,
        xeroContactId: "contact_current_link",
        joinedDate: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      });

    const report = await syncContactsFromXero();

    expect(report.updated).toEqual([]);
    expect(report.skippedNameMismatch).toEqual([]);
    expect(report.skippedOther).toEqual([
      {
        name: "John Smith",
        xeroContactId: "contact_duplicate_email",
        reason:
          "Matching member Jane Doe is already linked to a different Xero contact",
      },
    ]);
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
  });

  it("does not backfill an already-linked member when the linked contact name differs", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_linked_mismatch",
            name: "John Smith",
            firstName: "John",
            lastName: "Smith",
            emailAddress: "linked@example.com",
            phones: [
              {
                phoneType: "MOBILE",
                phoneCountryCode: "64",
                phoneAreaCode: "27",
                phoneNumber: "1234567",
              },
            ],
            addresses: [
              {
                addressType: "STREET",
                addressLine1: "1 Alpine Way",
                city: "Wanaka",
                region: "Otago",
                postalCode: "9305",
                country: "NZ",
              },
            ],
          },
        ],
      },
    });
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "linked@example.com",
      active: true,
      xeroContactId: "contact_linked_mismatch",
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });

    const report = await syncContactsFromXero();

    expect(report.updated).toEqual([]);
    expect(report.skippedNameMismatch).toEqual([
      {
        memberId: "member_1",
        memberName: "Jane Doe",
        memberEmail: "linked@example.com",
        xeroContactId: "contact_linked_mismatch",
        xeroContactName: "John Smith",
        xeroContactEmail: "linked@example.com",
        reasons: ["First name differs", "Last name differs"],
      },
    ]);
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
  });

  it("finds potential Xero contacts even when accents or punctuation differ", async () => {
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "José",
      lastName: "O'Connor-Smith",
      email: "jose@example.com",
    });
    mocks.accountingApi.getContacts
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              name: "Jose O Connor Smith",
              emailAddress: "jose@example.com",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              name: "Jose O Connor Smith",
              emailAddress: "jose@example.com",
            },
          ],
        },
      });

    const matches = await findPotentialXeroContactsForMember("member_1");

    expect(matches).toEqual([
      {
        contactId: "contact_1",
        name: "Jose O Connor Smith",
        email: "jose@example.com",
        isLinked: false,
        linkedMemberName: null,
        matchReasons: ["Exact email match", "Exact name match"],
        xeroLink: "https://xero.test/contacts/contact_1",
      },
    ]);
  });

  it("never sends a walk-in placeholder email as a Xero OData filter (#1935)", async () => {
    // A walk-in owner with no real address carries a club-internal placeholder
    // on the reserved `.invalid` domain. It must never reach getContacts as an
    // `EmailAddress="..."` filter (it would match nothing, or a stray contact) —
    // the email search is skipped and only the name search runs.
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_walkin",
      firstName: "Wanda",
      lastName: "Walkin",
      email: "walk-in-abc123@no-email.invalid",
    });
    // Only the name search resolves; keep it empty so the function short-circuits.
    mocks.accountingApi.getContacts.mockResolvedValue({ body: { contacts: [] } });

    const matches = await findPotentialXeroContactsForMember("member_walkin");

    expect(matches).toEqual([]);
    // Exactly one Xero call (the name search) — no email search.
    expect(mocks.accountingApi.getContacts).toHaveBeenCalledTimes(1);
    // No getContacts call ever carried an EmailAddress where-clause.
    for (const call of mocks.accountingApi.getContacts.mock.calls) {
      const whereClause = call[2];
      expect(String(whereClause ?? "")).not.toContain("EmailAddress");
      expect(String(whereClause ?? "")).not.toContain("no-email.invalid");
    }
  });

  it("imports members from cached group memberships and cached contacts without live Xero fetches", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_1" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      {
        contactId: "contact_1",
        name: "New Person",
        firstName: "New",
        lastName: "Person",
        emailAddress: "new@example.com",
        companyNumber: "02/03/2004",
        contactStatus: "ACTIVE",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "3334444",
        streetAddressLine1: "2 Snow Road",
        streetAddressLine2: null,
        streetCity: "Wanaka",
        streetRegion: "Otago",
        streetPostalCode: "9305",
        streetCountry: "NZ",
        postalAddressLine1: "PO Box 2",
        postalAddressLine2: null,
        postalCity: "Wanaka",
        postalRegion: "Otago",
        postalPostalCode: "9343",
        postalCountry: "NZ",
      },
    ]);
    mocks.prisma.member.findFirst.mockResolvedValue(null);

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
      false
    );

    expect(result).toMatchObject({
      created: 1,
      createdMembers: [
        {
          name: "New Person",
          email: "new@example.com",
          xeroContactId: "contact_1",
          group: "Adults",
        },
      ],
      errors: 0,
      groupsProcessed: ["Adults"],
    });
    expect(mocks.accountingApi.getContacts).not.toHaveBeenCalled();

    const createCall = mocks.prisma.member.create.mock.calls[0][0];
    expect(createCall.data).toEqual(
      expect.objectContaining({
        email: "new@example.com",
        firstName: "New",
        lastName: "Person",
        xeroContactId: "contact_1",
        phoneNumber: "3334444",
        streetAddressLine1: "2 Snow Road",
        postalAddressLine1: "PO Box 2",
      })
    );
    expect(createCall.data.joinedDate).toBeUndefined();
  });

  it("reports family dependents created from cached contacts", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_child", contactName: "Child Person" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      {
        contactId: "contact_child",
        name: "Child Person",
        firstName: "Child",
        lastName: "Person",
        emailAddress: "family@example.com",
        companyNumber: "02/03/2014",
        contactStatus: "ACTIVE",
        phoneCountryCode: null,
        phoneAreaCode: null,
        phoneNumber: null,
        streetAddressLine1: null,
        streetAddressLine2: null,
        streetCity: null,
        streetRegion: null,
        streetPostalCode: null,
        streetCountry: null,
        postalAddressLine1: null,
        postalAddressLine2: null,
        postalCity: null,
        postalRegion: null,
        postalPostalCode: null,
        postalCountry: null,
      },
    ]);
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "parent_1",
        email: "family@example.com",
        firstName: "Parent",
        lastName: "Person",
        xeroContactId: null,
        dateOfBirth: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      })
      .mockResolvedValueOnce(null);
    mocks.prisma.member.create.mockResolvedValue({
      id: "member_child",
      email: "family@example.com",
    });

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Children", ageTier: "CHILD" as any }],
      false
    );

    expect(result).toMatchObject({
      created: 0,
      createdAsDependent: 1,
      createdDependents: [
        {
          name: "Child Person",
          email: "family@example.com",
          xeroContactId: "contact_child",
          group: "Children",
          parentMemberId: "parent_1",
          parentName: "Parent Person",
        },
      ],
      errors: 0,
    });
  });

  it("REFUSES to import a contained contact as a member (#3036)", async () => {
    /*
      INV-CONFIG-005. A contained address must never become a `Member.email`. It
      is a hash of somebody's real address on a reserved domain, so a member
      created from it would read as REACHABLE — `isPlaceholderContactEmail` says
      nothing about this domain, deliberately — while being able to receive
      nothing at all. That is the silent-unreachability defect #2716 exists to
      prevent, arriving from a new direction.
    */
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
      lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
      metadata: {},
    });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      {
        contactGroupId: "group_1",
        contactId: "contact_contained",
        contactName: "Contained Person",
      },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_contained",
            name: "Contained Person",
            firstName: "Contained",
            lastName: "Person",
            emailAddress: toXeroSandboxContactEmail("real@example.com"),
            contactStatus: "ACTIVE",
          },
        ],
      },
    });

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
      false,
      { allowLiveXeroFetch: true },
    );

    expect(mocks.prisma.member.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      created: 0,
      skippedNoEmail: 1,
      errors: 0,
    });
    // And it says WHY, rather than claiming the contact has no address — it has
    // one, it just cannot be used.
    expect(result.skippedNoEmailDetails[0]).toMatchObject({
      xeroContactId: "contact_contained",
      reason: expect.stringContaining("non-deliverable"),
    });
  });

  it("includes archived contacts during repair and skips them instead of erroring", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_archived", contactName: "Archived Person" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_archived",
            name: "Archived Person",
            firstName: "Archived",
            lastName: "Person",
            emailAddress: "archived@example.com",
            contactStatus: "ARCHIVED",
          },
        ],
      },
    });

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
      false,
      { allowLiveXeroFetch: true }
    );

    expect(mocks.accountingApi.getContacts.mock.calls[0][6]).toBe(true);
    expect(result).toMatchObject({
      created: 0,
      skippedArchived: 1,
      skippedArchivedDetails: [
        {
          name: "Archived Person",
          xeroContactId: "contact_archived",
          group: "Adults",
          reason: "Xero contact status is ARCHIVED",
        },
      ],
      errors: 0,
    });
    expect(mocks.prisma.member.create).not.toHaveBeenCalled();
  });

  it("reports unrepaired missing snapshots with the cached group contact name", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_missing", contactName: "Missing Person" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);
    mocks.accountingApi.getContacts.mockResolvedValue({ body: { contacts: [] } });

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
      false,
      { allowLiveXeroFetch: true }
    );

    expect(result).toMatchObject({
      created: 0,
      errors: 1,
      errorDetails: [
        {
          member: "Adults: Missing Person",
          error: "Xero did not return a contact snapshot during repair, so this group member could not be imported.",
        },
      ],
    });
  });

  it("fails cached group import with a repair message when contact snapshots are missing", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_missing" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);

    await expect(
      importMembersFromXeroGroups(
        [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
        false
      )
    ).rejects.toThrow("Run contact sync first");

    expect(mocks.accountingApi.getContacts).not.toHaveBeenCalled();
  });
});
