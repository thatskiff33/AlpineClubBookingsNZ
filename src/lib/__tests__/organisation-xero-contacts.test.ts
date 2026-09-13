import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3367 (stage 2 of programme #2912): a school's Xero customer belongs to the
 * SCHOOL, is shaped like an organisation, and can only ever have one local home.
 *
 * What each section is here to catch, in the order the issue's acceptance
 * criteria put them:
 *
 *  1. THE SHAPE. A school arriving in Xero as a surnameless person is the defect
 *     the whole programme exists to fix, so the payload is asserted field by
 *     field — `name` populated, the person-name keys ABSENT rather than empty,
 *     and the real teacher attached as a contact person.
 *  2. IDEMPOTENCY UNDER REPLAY. The create carries an organisation-scoped
 *     idempotency key built by the REAL builder, so a retry converges on one
 *     contact instead of minting a second.
 *  3. ONE CONTACT, ONE LOCAL HOME (INV-INT-018): the ONE transfer — a school
 *     taking the contact its own invented member holds, which is the returning
 *     school and therefore the common case — and the refusal that still fires,
 *     unweakened, for every other holder.
 *  4. NO EMAIL SEARCH. The one place the organisation path deliberately
 *     diverges from the member path, because a school's recorded address is
 *     routinely a teacher's own and adopting that person's contact is what
 *     #2912 settled must never happen.
 *  5. THE CONTACT PERSON STAYS HONEST. No change costs no provider call; a
 *     change costs exactly one update.
 *  6. THE NO-ORGANISATION PATH IS UNCHANGED.
 */

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    organisation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    organisationContact: { findUnique: vi.fn() },
    // Everything the ONE transfer touches. A MISSING delegate here would be an
    // undefined-property throw rather than a wrong answer, which is how this
    // suite wants an unmocked read to behave.
    member: { findFirst: vi.fn(), update: vi.fn() },
    booking: { findFirst: vi.fn() },
    xeroObjectLink: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    organisationFindUnique: vi.fn(),
    xeroObjectLinkFindFirst: vi.fn(),
    environmentSafetySettingsFindUnique: vi.fn(),
    containmentFindUnique: vi.fn(),
    containmentUpsert: vi.fn(),
    getContacts: vi.fn(),
    createContacts: vi.fn(),
    updateContact: vi.fn(),
    getContact: vi.fn(),
    getAuthenticatedXeroClient: vi.fn(),
    startXeroSyncOperation: vi.fn(),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
    upsertXeroObjectLink: vi.fn(),
    findOrCreateXeroContact: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organisation: { findUnique: mocks.organisationFindUnique },
    xeroObjectLink: { findFirst: mocks.xeroObjectLinkFindFirst },
    $transaction: mocks.transaction,
    // #3034/#3036: a MISSING delegate is an UNREADABLE override, which resolves
    // UNKNOWN and makes #3036 refuse every Xero contact write — so without
    // these the suite would test the refusal path rather than the shape.
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
    // The REAL buildXeroIdempotencyKey and buildXeroPayloadHash stay, so the
    // key and the fingerprint are asserted against the real builders.
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

vi.mock("@/lib/xero-contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-contacts")>();
  return {
    ...actual,
    // The member fallback is asserted by identity, not re-exercised: the
    // no-organisation path's job is to be TODAY'S behaviour, and today's
    // behaviour has its own suites.
    findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  };
});

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  findOrCreateXeroContactForInvoicedParty,
  findOrCreateXeroContactForOrganisation,
} from "@/lib/organisation-xero-contacts";
import { XeroContactTwoHomesError } from "@/lib/xero-contact-home";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
} from "@/lib/__tests__/helpers/environment-role";
import { toXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";
import type { Contact } from "xero-node";

const ORGANISATION = {
  id: "org-1",
  name: "New Plymouth Primary School",
  email: "office@school.test",
  phone: "021 555 0000",
  xeroContactId: null as string | null,
  contacts: [
    {
      member: {
        firstName: "Ana",
        lastName: "Teacher",
        email: "ana@school.test",
      },
    },
  ],
};

function organisationRow(overrides: Partial<typeof ORGANISATION> = {}) {
  return { ...ORGANISATION, ...overrides };
}

/** The contact object the code handed `createContacts`. */
function sentContact(): Contact {
  const call = mocks.createContacts.mock.calls[0];
  return (call[1] as { contacts: Contact[] }).contacts[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  declareEnvironmentRole("production");
  mocks.environmentSafetySettingsFindUnique.mockResolvedValue(null);
  mocks.containmentFindUnique.mockResolvedValue(null);
  mocks.containmentUpsert.mockResolvedValue({});
  mocks.organisationFindUnique.mockResolvedValue(organisationRow());
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.tx.organisation.findUnique.mockResolvedValue({ xeroContactId: null });
  mocks.tx.organisation.update.mockResolvedValue({ id: "org-1" });
  mocks.tx.member.findFirst.mockResolvedValue(null);
  mocks.tx.member.update.mockResolvedValue({ id: "invented-school-member" });
  mocks.tx.booking.findFirst.mockResolvedValue(null);
  mocks.tx.organisationContact.findUnique.mockResolvedValue(null);
  mocks.tx.xeroObjectLink.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mocks.tx.$executeRaw.mockResolvedValue(1);
  mocks.transaction.mockImplementation(
    async (fn: (client: unknown) => Promise<unknown>) => fn(mocks.tx),
  );
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op-1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.upsertXeroObjectLink.mockResolvedValue(undefined);
  mocks.createContacts.mockResolvedValue({
    body: { contacts: [{ contactID: "contact-org-1" }] },
  });
  mocks.updateContact.mockResolvedValue({
    body: { contacts: [{ contactID: "contact-org-1" }] },
  });
  // On a copy, containment reads the contact back before it lets the id reach
  // anything that can invoice it. Answer with a contact already holding the
  // contained address, which is the "nothing to overwrite" branch.
  mocks.getContact.mockResolvedValue({
    body: {
      contacts: [
        {
          contactID: "contact-org-1",
          emailAddress: toXeroSandboxContactEmail("office@school.test"),
        },
      ],
    },
  });
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: {
      accountingApi: {
        getContacts: mocks.getContacts,
        createContacts: mocks.createContacts,
        updateContact: mocks.updateContact,
        getContact: mocks.getContact,
      },
    },
    tenantId: "tenant-1",
  });
});

describe("#3367: the school's Xero contact is shaped like an organisation", () => {
  it("sends the school's name alone and OMITS the person-name fields", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");
    await expect(findOrCreateXeroContactForOrganisation("org-1")).resolves.toBe(
      "contact-org-1",
    );

    const contact = sentContact();
    expect(contact.name).toBe("New Plymouth Primary School");
    // ABSENT, not empty. An empty surname beside a populated first name is
    // exactly what Xero renders as a nameless human, which is the defect.
    expect("firstName" in contact).toBe(false);
    expect("lastName" in contact).toBe(false);
    expect(contact.emailAddress).toBe("office@school.test");
  });

  it("names the real teacher as a contact person, without adding a mail channel", async () => {
    await findOrCreateXeroContactForOrganisation("org-1");

    expect(sentContact().contactPersons).toEqual([
      {
        firstName: "Ana",
        lastName: "Teacher",
        emailAddress: "ana@school.test",
        // Never true: Xero emails an included contact person from its own
        // servers, which this application cannot suppress with the booking's
        // "no emails" switch. The owner asked for "who to talk to", not a
        // second delivery channel.
        includeInEmails: false,
      },
    ]);
  });

  it("never claims isCustomer, which Xero refuses on write anyway", async () => {
    await findOrCreateXeroContactForOrganisation("org-1");
    expect("isCustomer" in sentContact()).toBe(false);
  });

  it("contains every address it sends on a copy of the club's site", async () => {
    vi.unstubAllEnvs();
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");

    await findOrCreateXeroContactForOrganisation("org-1");

    const contact = sentContact();
    expect(contact.emailAddress).toBe(
      toXeroSandboxContactEmail("office@school.test"),
    );
    // The teacher's address too — it is a person's address reaching the
    // provider as part of the school's record, so it is contained like any
    // other (INV-CONFIG-005).
    expect(contact.contactPersons?.[0]?.emailAddress).toBe(
      toXeroSandboxContactEmail("ana@school.test"),
    );
  });

  it("links the contact to the ORGANISATION, never to a member", async () => {
    await findOrCreateXeroContactForOrganisation("org-1");

    expect(mocks.tx.organisation.update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { xeroContactId: "contact-org-1" },
    });
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Organisation",
        localId: "org-1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact-org-1",
      }),
      expect.anything(),
    );
  });
});

describe("#3367: creating the contact is idempotent under replay", () => {
  it("keys the create on the ORGANISATION, using the real key builder", async () => {
    await findOrCreateXeroContactForOrganisation("org-1");

    const expected = buildXeroIdempotencyKey(
      "organisation",
      "org-1",
      "contact",
      "find-or-create",
      "v1",
    );
    // Position 4 of createContacts(tenantId, contacts, summarizeErrors, key).
    expect(mocks.createContacts.mock.calls[0][3]).toBe(expected);
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Organisation",
        localId: "org-1",
        idempotencyKey: expected,
        correlationKey: expected,
      }),
    );
  });

  it("makes no provider call at all once the link exists", async () => {
    mocks.organisationFindUnique.mockResolvedValue(
      organisationRow({ xeroContactId: "contact-org-1" }),
    );
    // The fingerprint of what was last sent matches what would be sent now.
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({
      metadata: {
        contactPersonsFingerprint: await fingerprintOfCurrentContactPersons(),
      },
    });

    await expect(findOrCreateXeroContactForOrganisation("org-1")).resolves.toBe(
      "contact-org-1",
    );
    expect(mocks.createContacts).not.toHaveBeenCalled();
    expect(mocks.updateContact).not.toHaveBeenCalled();
    // Not even an authentication: a school in steady state must cost nothing.
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("keeps a concurrent resolver's link rather than overwriting it", async () => {
    mocks.tx.organisation.findUnique.mockResolvedValue({
      xeroContactId: "contact-won-the-race",
    });

    await expect(findOrCreateXeroContactForOrganisation("org-1")).resolves.toBe(
      "contact-won-the-race",
    );
    expect(mocks.tx.organisation.update).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          resolution: "superseded_by_concurrent_link",
        }),
      }),
    );
  });
});

describe("#3367: one Xero contact, one local home (INV-INT-018)", () => {
  /** Xero's refusal when the contact name is already taken. */
  const DUPLICATE_NAME = Object.assign(new Error("Validation Exception"), {
    response: {
      body: {
        Elements: [
          {
            ValidationErrors: [
              {
                Message:
                  "The contact name New Plymouth Primary School is already assigned to another contact. The contact name must be unique across all active contacts.",
              },
            ],
          },
        ],
      },
    },
  });

  /**
   * A member holds the contact. Each test below then supplies exactly ONE
   * reason the transfer must not fire, so no test can pass for another's
   * reason — that is what makes the refusals discriminating rather than
   * merely red.
   */
  function aMemberHoldsTheContact(
    overrides: { canLogin?: boolean } = {},
  ) {
    // STATEFUL on purpose. The refusal re-reads the same unique column the
    // transfer just cleared, so a double that always answers "still held" would
    // make the transfer untestable and would be lying about the database. This
    // one releases the row exactly when the code writes the release — which is
    // also what lets the refusal below run UNWEAKENED on the transfer path.
    let held = true;
    mocks.tx.member.findFirst.mockImplementation(async () =>
      held ? { id: "invented-school-member", canLogin: overrides.canLogin ?? false } : null,
    );
    mocks.tx.member.update.mockImplementation(
      async (args: { data: { xeroContactId: string | null } }) => {
        if (args.data.xeroContactId === null) held = false;
        return { id: "invented-school-member" };
      },
    );
  }

  /** Leg 1 answers yes for THIS school; leg 2 (any other school) answers no. */
  function onlyThisSchoolsBookings() {
    mocks.tx.booking.findFirst.mockImplementation(
      async (args: { where: { organisationId?: string } }) =>
        args.where.organisationId === "org-1" ? { id: "booking-1" } : null,
    );
  }

  beforeEach(() => {
    mocks.createContacts.mockRejectedValue(DUPLICATE_NAME);
    mocks.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact-held-by-member",
            name: "New Plymouth Primary School",
          },
        ],
      },
    });
  });

  it("adopts the same-named contact when NOTHING else holds it", async () => {
    await expect(findOrCreateXeroContactForOrganisation("org-1")).resolves.toBe(
      "contact-held-by-member",
    );
    expect(mocks.tx.organisation.update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { xeroContactId: "contact-held-by-member" },
    });
    // Nothing was taken from anybody, so no member link was released.
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("TAKES the contact from the school's OWN invented member", async () => {
    aMemberHoldsTheContact();
    onlyThisSchoolsBookings();

    // The returning school: its Xero customer was created against the invented
    // member of an earlier booking, and the school now owns it. Owner decision,
    // 13 September 2026.
    await expect(findOrCreateXeroContactForOrganisation("org-1")).resolves.toBe(
      "contact-held-by-member",
    );
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "invented-school-member" },
      data: { xeroContactId: null },
    });
    expect(mocks.tx.organisation.update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { xeroContactId: "contact-held-by-member" },
    });
    // Never refused, so no failure row and no cancellation.
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("releases the member's CONTACT ledger row with the column", async () => {
    aMemberHoldsTheContact();
    onlyThisSchoolsBookings();

    await findOrCreateXeroContactForOrganisation("org-1");
    // Scoped to this contact and this role: an unrelated link on the same
    // record must survive the hand-over.
    expect(mocks.tx.xeroObjectLink.updateMany).toHaveBeenCalledWith({
      where: {
        localModel: "Member",
        localId: "invented-school-member",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact-held-by-member",
        active: true,
      },
      data: { active: false },
    });
  });

  it("audits the hand-over, in the same transaction, under `xero`", async () => {
    aMemberHoldsTheContact();
    onlyThisSchoolsBookings();

    await findOrCreateXeroContactForOrganisation("org-1");

    // Written through the REAL createAuditLog on the transaction's own client,
    // so the canonical-category assertion and the retention classification are
    // exercised rather than mocked past.
    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
    const row = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(row.action).toBe("xero.contact.moved_to_organisation");
    expect(row.category).toBe("xero");
    expect(row.severity).toBe("critical");
    expect(row.subjectMemberId).toBe("invented-school-member");
    expect(row.entityType).toBe("Organisation");
    expect(row.entityId).toBe("org-1");
    expect(row.metadata).toMatchObject({
      xeroContactId: "contact-held-by-member",
      fromMemberId: "invented-school-member",
      toOrganisationId: "org-1",
    });
    // INV-PRIV: ids and the school's own name, never a person's name or address.
    expect(JSON.stringify(row.metadata)).not.toContain("@");
  });

  it("commits the release and the claim together, never one without the other", async () => {
    aMemberHoldsTheContact();
    onlyThisSchoolsBookings();
    // Everything the hand-over touches runs on the SAME client the transaction
    // handed the callback, which is what makes "both or neither" true.
    await findOrCreateXeroContactForOrganisation("org-1");

    const inside = [
      mocks.tx.member.update,
      mocks.tx.organisation.update,
      mocks.tx.xeroObjectLink.updateMany,
      mocks.tx.auditLog.create,
    ];
    for (const call of inside) expect(call).toHaveBeenCalledTimes(1);
    const opened = mocks.transaction.mock.invocationCallOrder[0];
    for (const call of inside) {
      expect(call.mock.invocationCallOrder[0]).toBeGreaterThan(opened);
    }
  });

  it("REFUSES a member none of this school's bookings resolve to", async () => {
    aMemberHoldsTheContact();
    mocks.tx.booking.findFirst.mockResolvedValue(null);

    await expect(
      findOrCreateXeroContactForOrganisation("org-1"),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.tx.organisation.update).not.toHaveBeenCalled();
  });

  it("REFUSES a member that also books for a DIFFERENT school", async () => {
    aMemberHoldsTheContact();
    // Both legs answer: this school's bookings resolve to it, and so do
    // another's. A contact shared by two organisations belongs to neither.
    mocks.tx.booking.findFirst.mockResolvedValue({ id: "booking-1" });

    await expect(
      findOrCreateXeroContactForOrganisation("org-1"),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
  });

  it("REFUSES a member that can sign in", async () => {
    aMemberHoldsTheContact({ canLogin: true });
    onlyThisSchoolsBookings();

    await expect(
      findOrCreateXeroContactForOrganisation("org-1"),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
  });

  it("REFUSES one of the school's OWN named teachers", async () => {
    aMemberHoldsTheContact();
    onlyThisSchoolsBookings();
    mocks.tx.organisationContact.findUnique.mockResolvedValue({ id: "oc-1" });

    // A teacher is pushed to Xero as a contact person ON the school's record;
    // their personal Xero contact is exactly what #2912 forbids repurposing.
    await expect(
      findOrCreateXeroContactForOrganisation("org-1"),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
  });

  it("fails a refusal LOUDLY and replayably, never closing it as skipped", async () => {
    aMemberHoldsTheContact();
    mocks.tx.booking.findFirst.mockResolvedValue(null);

    await expect(
      findOrCreateXeroContactForOrganisation("org-1"),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);
    // FAILED, not CANCELLED-with-a-reason: a contact this organisation cannot
    // be given is a genuinely unresolved provider operation, and the
    // idempotency key it keeps is what makes a replay converge.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      expect.any(XeroContactTwoHomesError),
      expect.objectContaining({ resolvedContactId: "contact-held-by-member" }),
    );
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("takes the contact-home lock before it judges, and only local work is inside", async () => {
    await findOrCreateXeroContactForOrganisation("org-1");

    const keys = mocks.tx.$executeRaw.mock.calls.map((call) => call[1]);
    expect(keys).toEqual([
      "xero-organisation-contact:org-1",
      "xero-contact-home:contact-held-by-member",
    ]);
    // Every provider call happened BEFORE the transaction opened (F7, #1355).
    expect(mocks.createContacts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0],
    );
    expect(mocks.getContacts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0],
    );
  });

  it("does NOT fall back to the member when the organisation cannot be resolved", async () => {
    aMemberHoldsTheContact();
    mocks.tx.booking.findFirst.mockResolvedValue(null);

    // The fallback that raised the invoice against the member's own contact is
    // retired (owner, 13 September 2026). An Organisation-linked booking is
    // invoiced as the Organisation or not at all: an invoice against a customer
    // nobody chose is worse than an invoice that was not raised.
    await expect(
      findOrCreateXeroContactForInvoicedParty({
        memberId: "invented-school-member",
        organisationId: "org-1",
      }),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);
    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
  });

  it("lets any other provider failure through untouched", async () => {
    mocks.createContacts.mockRejectedValue(new Error("Xero is down"));

    await expect(
      findOrCreateXeroContactForInvoicedParty({
        memberId: "invented-school-member",
        organisationId: "org-1",
      }),
    ).rejects.toThrow("Xero is down");
    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
  });
});

describe("#3367: the organisation path never searches Xero by email", () => {
  it("asks Xero only by exact NAME, and only after a duplicate-name refusal", async () => {
    await findOrCreateXeroContactForOrganisation("org-1");
    // The happy path asks Xero nothing before creating.
    expect(mocks.getContacts).not.toHaveBeenCalled();
  });

  it("never sends an EmailAddress filter, even on the adoption path", async () => {
    mocks.createContacts.mockRejectedValue(
      Object.assign(new Error("Validation Exception"), {
        response: {
          body: {
            Elements: [
              {
                ValidationErrors: [
                  {
                    Message:
                      "The contact name New Plymouth Primary School is already assigned to another contact.",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    mocks.getContacts.mockResolvedValue({ body: { contacts: [] } });

    await expect(
      findOrCreateXeroContactForOrganisation("org-1"),
    ).rejects.toThrow();

    for (const call of mocks.getContacts.mock.calls) {
      // A school's recorded address is routinely a teacher's own, so an email
      // search would find and adopt that PERSON's contact — the one thing
      // #2912 settled must never happen.
      expect(JSON.stringify(call)).not.toContain("EmailAddress=");
    }
  });
});

describe("#3367: the named teacher is kept honest", () => {
  beforeEach(() => {
    mocks.organisationFindUnique.mockResolvedValue(
      organisationRow({ xeroContactId: "contact-org-1" }),
    );
  });

  it("pushes one update when the school's contact person has changed", async () => {
    // A stale fingerprint: the record names somebody who has left.
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({
      metadata: { contactPersonsFingerprint: "stale" },
    });

    await findOrCreateXeroContactForOrganisation("org-1");

    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    const [, contactId, payload] = mocks.updateContact.mock.calls[0];
    expect(contactId).toBe("contact-org-1");
    const sent = (payload as { contacts: Contact[] }).contacts[0];
    expect(sent.contactPersons?.[0]?.firstName).toBe("Ana");
    // The NAME is never rewritten. Xero enforces unique contact names, and
    // renaming is the operation #2912 forbids for a person's contact.
    expect("name" in sent).toBe(false);
  });

  it("records what it sent, so the next resolve costs nothing", async () => {
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({
      metadata: { contactPersonsFingerprint: "stale" },
    });

    await findOrCreateXeroContactForOrganisation("org-1");

    const fingerprintWrite = mocks.upsertXeroObjectLink.mock.calls.find(
      ([link]) =>
        (link as { metadata?: Record<string, unknown> }).metadata
          ?.contactPersonsFingerprint,
    );
    expect(fingerprintWrite).toBeDefined();
  });

  it("does not fail the invoice when the refresh cannot be sent", async () => {
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({
      metadata: { contactPersonsFingerprint: "stale" },
    });
    mocks.updateContact.mockRejectedValue(new Error("Xero is down"));

    // Best-effort: a school's invoice must not fail because the teacher's name
    // on the contact could not be corrected. The fingerprint is not advanced,
    // so the next resolve tries again.
    await expect(findOrCreateXeroContactForOrganisation("org-1")).resolves.toBe(
      "contact-org-1",
    );
    expect(mocks.failXeroSyncOperation).toHaveBeenCalled();
  });
});

describe("#3367: a booking with no organisation behaves exactly as it does today", () => {
  it("resolves the booking's member, and touches nothing organisation-shaped", async () => {
    mocks.findOrCreateXeroContact.mockResolvedValue("contact-member");

    await expect(
      findOrCreateXeroContactForInvoicedParty(
        { memberId: "member-1", organisationId: null },
        { createdByMemberId: "admin-1" },
      ),
    ).resolves.toBe("contact-member");

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledWith("member-1", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.organisationFindUnique).not.toHaveBeenCalled();
    expect(mocks.createContacts).not.toHaveBeenCalled();
  });
});

/**
 * The fingerprint the code would compute for the fixture organisation right
 * now, built from the REAL hash so a steady-state assertion is not testing a
 * constant this file invented.
 */
async function fingerprintOfCurrentContactPersons(): Promise<string> {
  const { buildXeroPayloadHash } = await vi.importActual<
    typeof import("@/lib/xero-sync")
  >("@/lib/xero-sync");
  return buildXeroPayloadHash({
    contactPersons: [
      {
        firstName: "Ana",
        lastName: "Teacher",
        emailAddress: "ana@school.test",
        includeInEmails: false,
      },
    ],
  });
}
