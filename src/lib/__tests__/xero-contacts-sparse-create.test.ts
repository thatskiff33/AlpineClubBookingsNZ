import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Phone } from "xero-node";

// -----------------------------------------------------------------------------
// #2089: createXeroContactForMember must succeed for a sparse member (name +
// email only). The payload it sends to Xero must contain NO empty address
// blocks and NO empty-string phone entry, and the member-scoped idempotency key
// must be unchanged. A member missing name/email is still rejected up-front by
// the shrunk create gate (XeroContactValidationError).
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  txMemberFindUnique: vi.fn(),
  txMemberUpdate: vi.fn(),
  txXeroOperationFindFirst: vi.fn(),
  txExecuteRaw: vi.fn(),
  txQueryRaw: vi.fn(),
  transaction: vi.fn(),
  createContacts: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
  recordProviderCreatedContactPendingLocalLink: vi.fn(),
  environmentSafetySettingsFindUnique: vi.fn(),
  containmentFindUnique: vi.fn(),
  containmentUpsert: vi.fn(),
  getContact: vi.fn(),
  updateContact: vi.fn(),
}));

vi.mock("@/lib/xero-contact-create-recovery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-contact-create-recovery")>();
  return {
    ...actual,
    recordProviderCreatedContactPendingLocalLink:
      mocks.recordProviderCreatedContactPendingLocalLink,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    $transaction: mocks.transaction,
    // #3034/#3036: a MISSING delegate here is an UNREADABLE override, which
    // resolves UNKNOWN and makes #3036 refuse every Xero contact write — so the
    // payload-hygiene assertions below would never be reached. Inline, because
    // `vi.mock` factories hoist above this file's imports.
    environmentSafetySettings: {
      findUnique: mocks.environmentSafetySettingsFindUnique,
    },
    xeroSandboxContactContainment: {
      findUnique: mocks.containmentFindUnique,
      upsert: mocks.containmentUpsert,
    },
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    // Keep the REAL buildXeroIdempotencyKey so we can assert the create key is
    // unchanged against the real builder.
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    callXeroApi: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock("@/lib/xero-contact-groups", () => ({
  syncManagedXeroContactGroupForMember:
    mocks.syncManagedXeroContactGroupForMember,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  createXeroContactForMember,
  XeroContactCreatePartialSuccessError,
  XeroContactValidationError,
} from "@/lib/xero-contacts";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
} from "@/lib/__tests__/helpers/environment-role";
import {
  toXeroSandboxContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";
import {
  ambiguousMemberContactCreateReservationWhere,
  XeroContactCreateInProgressError,
} from "@/lib/xero-contact-create-recovery";

const SPARSE_MEMBER = {
  id: "member-1",
  firstName: "Alice",
  lastName: "Example",
  email: "alice@example.org",
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
  dateOfBirth: null,
  joinedDate: null,
  xeroContactId: null,
};

function primeHappyPath(member: Record<string, unknown>) {
  mocks.memberFindUnique.mockResolvedValue({ ...member });
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: {
      accountingApi: {
        createContacts: mocks.createContacts,
        // #3036: containment reads the created contact back before it records
        // that the contact can no longer reach a member.
        getContact: mocks.getContact,
        updateContact: mocks.updateContact,
      },
    },
    tenantId: "tenant-1",
  });
  mocks.createContacts.mockResolvedValue({
    body: { contacts: [{ contactID: "contact-new", name: "Alice Example" }] },
  });
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op-1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.upsertXeroObjectLink.mockResolvedValue({ id: "link-1" });
  mocks.syncManagedXeroContactGroupForMember.mockResolvedValue(undefined);
  mocks.recordProviderCreatedContactPendingLocalLink.mockResolvedValue(undefined);
  mocks.txExecuteRaw.mockResolvedValue(1);
  mocks.txMemberFindUnique.mockResolvedValue({ ...member });
  mocks.txXeroOperationFindFirst.mockResolvedValue(null);
  mocks.txQueryRaw.mockImplementation(
    async (_strings: TemplateStringsArray, memberId: string) => [{ id: memberId }],
  );
  mocks.txMemberUpdate.mockResolvedValue({ id: member.id });
  mocks.getContact.mockResolvedValue({
    body: { contacts: [{ contactID: "contact-new", emailAddress: "" }] },
  });
  mocks.updateContact.mockResolvedValue({ body: {} });
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: mocks.txExecuteRaw,
        $queryRaw: mocks.txQueryRaw,
        member: {
          findUnique: mocks.txMemberFindUnique,
          update: mocks.txMemberUpdate,
        },
        xeroSyncOperation: {
          findFirst: mocks.txXeroOperationFindFirst,
        },
      })
  );
}

function sentContact() {
  const [, body] = mocks.createContacts.mock.calls[0] as [
    string,
    { contacts: Array<Record<string, unknown>> },
    unknown,
    string,
  ];
  return body.contacts[0];
}

describe("createXeroContactForMember payload hygiene (#2089)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The club's LIVE site: #3036's containment is a no-op, so the payload this
    // suite inspects is byte-for-byte the payload it always inspected.
    declareEnvironmentRole("production");
    mocks.environmentSafetySettingsFindUnique.mockResolvedValue(null);
    mocks.containmentFindUnique.mockResolvedValue(null);
    mocks.containmentUpsert.mockResolvedValue({});
  });

  it("on a COPY it sends the contained address and records the proof (#3036)", async () => {
    // `createXeroContactForMember` is the admin "push this member to Xero"
    // entry point and does not go through the funnel, so it needs its own proof
    // that INV-CONFIG-005 covers it.
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    primeHappyPath(SPARSE_MEMBER);
    mocks.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact-new",
            emailAddress: toXeroSandboxContactEmail("alice@example.org"),
          },
        ],
      },
    });

    await expect(createXeroContactForMember("member-1")).resolves.toBe(
      "contact-new",
    );

    const [, payload] = mocks.createContacts.mock.calls[0];
    expect(payload.contacts[0].emailAddress).toBe(
      toXeroSandboxContactEmail("alice@example.org"),
    );
    expect(payload.contacts[0].emailAddress).not.toContain("alice@example.org");
    expect(mocks.getContact).toHaveBeenCalledWith("tenant-1", "contact-new");
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.containmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { xeroContactId: "contact-new" },
        create: {
          xeroContactId: "contact-new",
          containedEmail: xeroSandboxContainmentTarget("alice@example.org"),
          // The contact was created carrying the contained address, so nothing
          // deliverable was overwritten and there is no rewrite to date.
          rewroteAddress: false,
          rewrittenAt: null,
        },
      }),
    );
  });

  it("reports created-and-linked when the containment proof fails afterwards (#3036)", async () => {
    /*
      The contact EXISTS and is LINKED by the time containment runs, so a bare
      error would tell the operator nothing was recorded and leave them pressing
      Create again — which the reservation refuses for an already-linked member.
      The partial-success phase carries the created contact id instead, and the
      route renders it as created-and-linked with post-processing pending, which
      is exactly what is true. It still FAILS rather than proceeding.
    */
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    primeHappyPath(SPARSE_MEMBER);
    mocks.getContact.mockRejectedValue(new Error("503 from Xero"));

    await expect(createXeroContactForMember("member-1")).rejects.toMatchObject({
      name: "XeroContactCreatePartialSuccessError",
      phase: "LOCAL_MEMBER_LINK_COMMITTED",
      xeroContactId: "contact-new",
    });
    expect(mocks.containmentUpsert).not.toHaveBeenCalled();
  });

  it("creates a sparse member with no address blocks and no phone entry", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");
    primeHappyPath(SPARSE_MEMBER);

    const result = await createXeroContactForMember("member-1");

    expect(result).toBe("contact-new");
    expect(mocks.createContacts).toHaveBeenCalledTimes(1);

    const contact = sentContact();
    expect(contact.name).toBe("Alice Example");
    expect(contact.emailAddress).toBe("alice@example.org");
    // No empty address blocks.
    expect(contact.addresses).toEqual([]);
    // No empty-string phone entry.
    expect(contact.phones).toEqual([]);
  });

  it("keeps the member-scoped create idempotency key unchanged", async () => {
    primeHappyPath(SPARSE_MEMBER);

    await createXeroContactForMember("member-1");

    const call = mocks.createContacts.mock.calls[0];
    // createContacts(tenantId, body, undefined, idempotencyKey)
    expect(call[3]).toBe(
      buildXeroIdempotencyKey("member", "member-1", "contact", "create", "v1")
    );
    // startXeroSyncOperation carries the same key.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: buildXeroIdempotencyKey(
          "member",
          "member-1",
          "contact",
          "create",
          "v1"
        ),
        operationType: "CREATE",
        entityType: "CONTACT",
      })
    );
  });

  it.each([
    ["active", { id: "operation-running", status: "RUNNING" }],
    [
      "stale orphaned",
      {
        id: "operation-stale",
        status: "FAILED",
        lastErrorCode: "ORPHANED_STALE_RUNNING",
      },
    ],
  ])(
    "refuses a %s contact-create reservation before authentication or provider work",
    async (_label, reservation) => {
      primeHappyPath(SPARSE_MEMBER);
      mocks.txXeroOperationFindFirst.mockResolvedValueOnce(reservation);

      await expect(
        createXeroContactForMember("member-1"),
      ).rejects.toBeInstanceOf(XeroContactCreateInProgressError);

      expect(mocks.txXeroOperationFindFirst).toHaveBeenCalledWith({
        where: ambiguousMemberContactCreateReservationWhere("member-1"),
        select: { id: true },
      });
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.createContacts).not.toHaveBeenCalled();
    },
  );

  it("still sends a MOBILE phone block when any phone part is present", async () => {
    primeHappyPath({
      ...SPARSE_MEMBER,
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "5551234",
    });

    await createXeroContactForMember("member-1");

    const contact = sentContact();
    expect(contact.phones).toEqual([
      {
        phoneType: Phone.PhoneTypeEnum.MOBILE,
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "5551234",
      },
    ]);
  });

  it("sends a phone block even when only the area code is present", async () => {
    primeHappyPath({ ...SPARSE_MEMBER, phoneAreaCode: "27" });

    await createXeroContactForMember("member-1");

    expect(sentContact().phones).toEqual([
      {
        phoneType: Phone.PhoneTypeEnum.MOBILE,
        phoneCountryCode: "",
        phoneAreaCode: "27",
        phoneNumber: "",
      },
    ]);
  });

  it("sends both address blocks when the member has full addresses", async () => {
    primeHappyPath({
      ...SPARSE_MEMBER,
      streetAddressLine1: "1 Main Rd",
      streetCity: "Wellington",
      postalAddressLine1: "PO Box 9",
      postalCity: "Wellington",
    });

    await createXeroContactForMember("member-1");

    const addresses = sentContact().addresses as Array<{ addressType: string }>;
    expect(addresses).toHaveLength(2);
    expect(addresses.map((a) => a.addressType)).toEqual([
      Address.AddressTypeEnum.STREET,
      Address.AddressTypeEnum.POBOX,
    ]);
  });

  it("sends the date of birth as the NZBN company number, and still never sends joined date", async () => {
    // #2859 REVERSES HALF OF THIS TEST. It used to assert that a create payload
    // carried NO date at all, and that assertion was the defect: the owner's
    // report was that a member's date of birth never appeared in Xero's NZBN
    // field, and it never did, on any path. The date of birth now goes; the
    // JOINED date still does not, because it only ever round-trips through the
    // import/backfill direction.
    primeHappyPath({
      ...SPARSE_MEMBER,
      dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
      joinedDate: new Date("2024-05-01T00:00:00.000Z"),
    });

    await createXeroContactForMember("member-1");

    const contact = sentContact();
    // `dd/mm/yyyy`, the exact shape the import side has always read back.
    expect(contact.companyNumber).toBe("15/01/1990");
    // The joined date has no Xero field on create and must not invent one.
    expect(contact).not.toHaveProperty("dateOfBirth");
    expect(contact).not.toHaveProperty("validationDate");
    // The rest of the payload is exactly the sparse name + email shape.
    expect(contact.name).toBe("Alice Example");
    expect(contact.firstName).toBe("Alice");
    expect(contact.lastName).toBe("Example");
    expect(contact.emailAddress).toBe("alice@example.org");
    expect(contact.phones).toEqual([]);
    expect(contact.addresses).toEqual([]);
    // Exactly the seven known keys — nothing else leaked in.
    expect(Object.keys(contact).sort()).toEqual([
      "addresses",
      "companyNumber",
      "emailAddress",
      "firstName",
      "lastName",
      "name",
      "phones",
    ]);
  });

  it("omits the company number entirely for a member with no date of birth", async () => {
    // #2859: absence is expressed by OMISSION, never by `""`. Xero's
    // `CompanyNumber` is the NZBN field, and an organisation or school account
    // may carry a real New Zealand Business Number there. Blanking it to say
    // "this member has no date of birth" would destroy the club's own
    // accounting data to state an absence nobody asked for.
    primeHappyPath({ ...SPARSE_MEMBER, dateOfBirth: null });

    await createXeroContactForMember("member-1");

    const contact = sentContact();
    expect(contact).not.toHaveProperty("companyNumber");
    expect(Object.keys(contact).sort()).toEqual([
      "addresses",
      "emailAddress",
      "firstName",
      "lastName",
      "name",
      "phones",
    ]);
  });

  it("reports provider-created when the local member link fails", async () => {
    primeHappyPath(SPARSE_MEMBER);
    const linkFailure = new Error("private database detail");
    mocks.transaction
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: mocks.txExecuteRaw,
          $queryRaw: mocks.txQueryRaw,
          member: {
            findUnique: mocks.txMemberFindUnique,
            update: mocks.txMemberUpdate,
          },
          xeroSyncOperation: {
            findFirst: mocks.txXeroOperationFindFirst,
          },
        }),
      )
      .mockRejectedValueOnce(linkFailure);

    const error = await createXeroContactForMember("member-1").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(XeroContactCreatePartialSuccessError);
    expect(error).toMatchObject({
      message: "Xero contact creation completed only in part",
      phase: "PROVIDER_CONTACT_CREATED",
      xeroContactId: "contact-new",
      originalError: linkFailure,
    });
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      linkFailure,
      expect.objectContaining({
        phase: "local_link_after_xero_resolution",
        resolvedContactId: "contact-new",
        providerContactCreated: true,
      }),
    );
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("retains the pre-link provider proof when recording the terminal failure also fails", async () => {
    primeHappyPath(SPARSE_MEMBER);
    const linkFailure = new Error("local link unavailable");
    mocks.txMemberUpdate.mockRejectedValue(linkFailure);
    mocks.failXeroSyncOperation.mockRejectedValue(
      new Error("failure recorder unavailable"),
    );

    const error = await createXeroContactForMember("member-1").catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      phase: "PROVIDER_CONTACT_CREATED",
      xeroContactId: "contact-new",
      originalError: linkFailure,
    });
    expect(
      mocks.recordProviderCreatedContactPendingLocalLink,
    ).toHaveBeenCalledWith({
      operationId: "op-1",
      resolvedContactId: "contact-new",
    });
    expect(
      mocks.recordProviderCreatedContactPendingLocalLink.mock
        .invocationCallOrder[0],
    ).toBeLessThan(mocks.txMemberUpdate.mock.invocationCallOrder[0]);
    expect(mocks.failXeroSyncOperation).toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("returns provider-created recovery when both proof recorders fail before linking", async () => {
    primeHappyPath(SPARSE_MEMBER);
    const proofFailure = new Error("pending proof recorder unavailable");
    mocks.recordProviderCreatedContactPendingLocalLink.mockRejectedValue(
      proofFailure,
    );
    mocks.failXeroSyncOperation.mockRejectedValue(
      new Error("terminal proof recorder unavailable"),
    );

    const error = await createXeroContactForMember("member-1").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(XeroContactCreatePartialSuccessError);
    expect(error).toMatchObject({
      phase: "PROVIDER_CONTACT_CREATED",
      xeroContactId: "contact-new",
      originalError: proofFailure,
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalled();
    expect(mocks.recordProviderCreatedContactPendingLocalLink).toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      proofFailure,
      expect.objectContaining({
        providerContactCreated: true,
      }),
    );
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("reports local-link-committed when operation close fails post-commit", async () => {
    primeHappyPath(SPARSE_MEMBER);
    const completionFailure = new Error("private operation detail");
    mocks.completeXeroSyncOperation.mockRejectedValue(completionFailure);

    const error = await createXeroContactForMember("member-1").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(XeroContactCreatePartialSuccessError);
    expect(error).toMatchObject({
      message: "Xero contact creation completed only in part",
      phase: "LOCAL_MEMBER_LINK_COMMITTED",
      xeroContactId: "contact-new",
      originalError: completionFailure,
    });
    expect(mocks.txMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { xeroContactId: "contact-new" },
    });
  });

  it("rejects a member missing email before any Xero call", async () => {
    primeHappyPath({ ...SPARSE_MEMBER, email: "" });

    await expect(createXeroContactForMember("member-1")).rejects.toBeInstanceOf(
      XeroContactValidationError
    );
    await expect(
      createXeroContactForMember("member-1")
    ).rejects.toMatchObject({ missingFields: ["Email"] });
    expect(mocks.createContacts).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("rejects a member missing name before any Xero call", async () => {
    primeHappyPath({ ...SPARSE_MEMBER, firstName: "", lastName: "" });

    await expect(
      createXeroContactForMember("member-1")
    ).rejects.toMatchObject({ missingFields: ["First Name", "Last Name"] });
    expect(mocks.createContacts).not.toHaveBeenCalled();
  });
});
