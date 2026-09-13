/**
 * #2939 — the missing-Xero-contact census and its bounded seeding run.
 *
 * WHAT THIS FILE IS PINNING, and why each half needs its own kind of proof.
 *
 * The CENSUS is pure classification over local reads, so it is asserted
 * directly: given this member and this cached contact, which bucket. The five
 * ambiguity classes get one case each, because each of them is a question with
 * more than one defensible answer and the issue's contract is that none of them
 * is guessed.
 *
 * The RUN owns almost no behaviour of its own — every contact is resolved by
 * `findOrCreateXeroContact`, which is where link-before-create, the
 * member-scoped idempotency key and the `INV-INT-018` refusal live. So what is
 * pinned here is the part the run really decides: that it calls the funnel
 * rather than anything else, that it touches only the intersection of the
 * reviewed set with a freshly recomputed pushable set, that one member's
 * failure does not stall the chunk, and that the environment gate is asked
 * before any of it. Asserting the funnel's own guarantees again here would test
 * the mock, not the code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroSyncCursor: { findUnique: vi.fn() },
    member: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    booking: { findMany: vi.fn() },
    bookingRequest: { findMany: vi.fn() },
    organisation: { findMany: vi.fn() },
    xeroContactCache: { findMany: vi.fn() },
    xeroGroupingSettings: { findUnique: vi.fn() },
    xeroObjectLink: { findFirst: vi.fn() },
    xeroSyncOperation: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
  findOrCreateXeroContact: vi.fn(),
  assertXeroProviderWriteAllowed: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/xero-environment-write-gate", async (importOriginal) => {
  // The type moved OUT of the call (#3318): a type argument containing an
  // `import()` type makes Semgrep skip a region of this file silently.
  const actual =
    (await importOriginal()) as typeof import("@/lib/xero-environment-write-gate");
  return {
    ...actual,
    assertXeroProviderWriteAllowed: mocks.assertXeroProviderWriteAllowed,
  };
});
/*
  PARTIAL, through `importOriginal`, on purpose. Only the funnel is replaced;
  `getMissingFieldsForXeroContactCreate` and
  `XeroContactCreatePartialSuccessError` come through real, so the create gate
  this census applies is the SAME function the payload builder applies
  (INV-SSOT) rather than a second copy written to agree with it.
*/
vi.mock("@/lib/xero-contacts", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contacts");
  return { ...actual, findOrCreateXeroContact: mocks.findOrCreateXeroContact };
});

import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { XeroContactTwoHomesError } from "@/lib/xero-contact-home";
import {
  XeroContactCreatePartialSuccessError,
  XeroContactProviderAnswerUnavailableError,
} from "@/lib/xero-contacts";
import { getXeroMissingContactSnapshot } from "@/lib/xero-missing-contact-seeding";
import { runXeroMissingContactSeedingChunk } from "@/lib/xero-missing-contact-seeding-run";
import {
  DEFAULT_SEEDING_CHUNK,
  DEFAULT_SEEDING_CHUNK_WITH_GROUPING,
  SeedingPlanChangedError,
} from "@/lib/xero-missing-contact-seeding-shape";

const SYNCED_AT = new Date("2026-06-01T00:00:00.000Z");

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    passwordHash: "hash",
    role: "USER",
    xeroContactId: null,
    ...overrides,
  };
}

function cachedContact(overrides: Record<string, unknown> = {}) {
  return {
    contactId: "c1",
    name: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    emailAddress: "ada@example.com",
    contactStatus: "ACTIVE",
    ...overrides,
  };
}

/** Population members, cached contacts, and who already holds which contact. */
function givenTree(input: {
  members?: ReturnType<typeof member>[];
  contacts?: ReturnType<typeof cachedContact>[];
  heldByMembers?: string[];
  heldByOrganisations?: string[];
  schoolBookingMemberIds?: string[];
  schoolRequestMemberIds?: string[];
  syncedAt?: Date | null;
  groupingMode?: "NONE" | "MEMBERSHIP_TYPE" | "MEMBERSHIP_TYPE_AND_AGE";
}) {
  mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(
    input.syncedAt === null
      ? null
      : { lastSuccessfulSyncAt: input.syncedAt ?? SYNCED_AT },
  );
  mocks.prisma.member.findMany.mockImplementation(async (args: {
    where?: {
      xeroContactId?: { in?: string[]; not?: null };
      id?: { in?: string[] };
    };
  }) => {
    // The held-by read is the only one keyed on a contact-id set.
    if (args?.where?.xeroContactId?.in) {
      return (input.heldByMembers ?? []).map((contactId) => ({
        xeroContactId: contactId,
      }));
    }
    /*
      The run's "which reviewed members already hold a contact" read, which is
      what separates ALREADY_DONE from NO_LONGER_PUSHABLE. Keyed on an id set
      plus a non-null contact, and answered from the SAME fixtures rather than
      from a second list, so the two states cannot be set independently of what
      the population actually says.
    */
    if (args?.where?.id?.in) {
      const ids = args.where.id.in;
      return (input.members ?? [member()])
        .filter((row) => ids.includes(row.id) && row.xeroContactId !== null)
        .map((row) => ({ id: row.id }));
    }
    return input.members ?? [member()];
  });
  mocks.prisma.booking.findMany.mockResolvedValue(
    (input.schoolBookingMemberIds ?? []).map((memberId) => ({ memberId })),
  );
  mocks.prisma.bookingRequest.findMany.mockResolvedValue(
    (input.schoolRequestMemberIds ?? []).map((convertedMemberId) => ({
      convertedMemberId,
    })),
  );
  mocks.prisma.organisation.findMany.mockResolvedValue(
    (input.heldByOrganisations ?? []).map((xeroContactId) => ({ xeroContactId })),
  );
  /*
    The `where` is APPLIED rather than ignored. A mock that hands back every
    fixture whatever was asked for cannot tell a filtered read from an
    unfiltered one, so the `contactStatus: "ACTIVE"` narrowing would be
    unfalsifiable — measured: a mutation removing it survived until this mock
    started honouring the clause.
  */
  mocks.prisma.xeroContactCache.findMany.mockImplementation(async (args: {
    where?: { contactStatus?: string; emailAddress?: { not?: null } };
  }) =>
    (input.contacts ?? []).filter(
      (contact) =>
        (args?.where?.contactStatus === undefined ||
          contact.contactStatus === args.where.contactStatus) &&
        /*
          #2939: the address narrowing is honoured too, for the same reason the
          status narrowing is. The read used to require a non-null address,
          which made every blank-email contact invisible — and a blank-email
          contact is precisely one that can only ever be matched by NAME. A mock
          that ignored this clause could not tell the two reads apart, so
          re-adding the narrowing would survive.
        */
        (args?.where?.emailAddress?.not !== null ||
          contact.emailAddress !== null),
    ),
  );
  mocks.prisma.xeroGroupingSettings.findUnique.mockResolvedValue(
    input.groupingMode === undefined ? null : { mode: input.groupingMode },
  );
}

/**
 * The digest of the plan the census currently produces — what an operator who
 * has just read the screen would post. Taken from the same dry run the run
 * re-computes, so a test that passes it is asserting the guard rather than
 * re-implementing the hash.
 */
async function reviewedDigest(): Promise<string> {
  return (await getXeroMissingContactSnapshot()).plannedDigest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
    metadata: { linkedVia: "created" },
  });
  mocks.findOrCreateXeroContact.mockResolvedValue("c-new");
  mocks.assertXeroProviderWriteAllowed.mockResolvedValue(undefined);
  givenTree({});
});

describe("the dry run (#2939)", () => {
  it("writes nothing and enqueues nothing", async () => {
    await getXeroMissingContactSnapshot();

    for (const [label, spy] of [
      ["member.create", mocks.prisma.member.create],
      ["member.update", mocks.prisma.member.update],
      ["member.updateMany", mocks.prisma.member.updateMany],
      ["xeroSyncOperation.create", mocks.prisma.xeroSyncOperation.create],
      ["auditLog.create", mocks.prisma.auditLog.create],
      ["$transaction", mocks.prisma.$transaction],
      ["$executeRaw", mocks.prisma.$executeRaw],
      ["findOrCreateXeroContact", mocks.findOrCreateXeroContact],
    ] as const) {
      expect(spy, `the dry run must not call ${label}`).not.toHaveBeenCalled();
    }
  });

  it("refuses to answer until the Xero contact cache has been synced once", async () => {
    givenTree({ syncedAt: null });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.cacheReady).toBe(false);
    // Not "zero members need a contact" — every count is zero because nothing
    // was classified. The route turns this into an instruction, not a result.
    expect(snapshot.eligible).toBe(0);
    expect(snapshot.pushable).toBe(0);
    expect(snapshot.pushableRows).toEqual([]);
    expect(mocks.prisma.member.findMany).not.toHaveBeenCalled();
  });

  it("counts an already-linked member without proposing anything for them", async () => {
    givenTree({ members: [member({ xeroContactId: "c-existing" })] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.eligible).toBe(1);
    expect(snapshot.alreadyLinked).toBe(1);
    expect(snapshot.unlinked).toBe(0);
    expect(snapshot.pushable).toBe(0);
  });

  it("proposes a create when nothing cached carries the address", async () => {
    givenTree({ members: [member()], contacts: [] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.pushableRows).toEqual([
      {
        memberId: "m1",
        memberName: "Ada Lovelace",
        memberEmail: "ada@example.com",
        evidence: "NO_CACHED_MATCH",
        cachedXeroContactId: null,
      },
    ]);
  });

  it("proposes a LINK when a cached contact matches by address and name", async () => {
    givenTree({ members: [member()], contacts: [cachedContact()] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.pushableRows[0]).toMatchObject({
      memberId: "m1",
      evidence: "CACHED_CONTACT_MATCH",
      cachedXeroContactId: "c1",
    });
  });

  it("ignores an ARCHIVED Xero contact on the same address", async () => {
    /*
      An archived contact is not a contact the funnel can adopt: its live email
      search excludes archived rows, so proposing a link to one would promise
      something the run cannot deliver. Creating is the honest answer, and it is
      the same discrimination `findOrCreateXeroContact`'s repair-path name
      search makes for the same reason.
    */
    givenTree({
      members: [member()],
      contacts: [cachedContact({ contactStatus: "ARCHIVED" })],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguous).toBe(0);
    expect(snapshot.pushableRows[0]).toMatchObject({
      memberId: "m1",
      evidence: "NO_CACHED_MATCH",
      cachedXeroContactId: null,
    });
  });

  it("matches the address case-insensitively", async () => {
    givenTree({
      members: [member({ email: "ADA@Example.com" })],
      contacts: [cachedContact({ emailAddress: "ada@EXAMPLE.com" })],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.pushableRows[0]?.evidence).toBe("CACHED_CONTACT_MATCH");
  });
});

describe("who never reaches the population (#2939)", () => {
  it("excludes a school member record", async () => {
    givenTree({ members: [member({ role: "SCHOOL" })] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("SCHOOL_MEMBER_RECORD");
    expect(snapshot.eligible).toBe(0);
    expect(snapshot.pushable).toBe(0);
  });

  it("excludes a member who owns a booking carrying an organisation", async () => {
    givenTree({ members: [member()], schoolBookingMemberIds: ["m1"] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("SCHOOL_BOOKING_CONTACT");
  });

  it("excludes a member a school's booking REQUEST converted into", async () => {
    // The pre-release generation: `Booking.organisationId` is NULL for a school
    // that booked before #3367, so the request half is what reaches it.
    givenTree({ members: [member()], schoolRequestMemberIds: ["m1"] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("SCHOOL_BOOKING_CONTACT");
  });

  it("excludes an anonymised account", async () => {
    givenTree({
      members: [member({ email: "deleted-abc@deleted.invalid" })],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("ANONYMISED_ACCOUNT");
  });

  it("excludes a walk-in placeholder address", async () => {
    givenTree({ members: [member({ email: "walk-in-abc@no-email.invalid" })] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("NO_REAL_EMAIL_ADDRESS");
  });

  it("excludes a member the create gate would refuse", async () => {
    givenTree({ members: [member({ lastName: "   " })] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("INCOMPLETE_DETAILS");
  });
});

describe("ambiguity is handed back, never guessed (#2939)", () => {
  it("refuses a contact a school already holds", async () => {
    givenTree({
      members: [member()],
      contacts: [cachedContact()],
      heldByOrganisations: ["c1"],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.pushable).toBe(0);
    expect(snapshot.ambiguousRows[0]).toMatchObject({
      memberId: "m1",
      reason: "XERO_CONTACT_BELONGS_TO_A_SCHOOL",
      xeroContactIds: ["c1"],
    });
  });

  it("refuses a contact another member already holds", async () => {
    givenTree({
      members: [member()],
      contacts: [cachedContact()],
      heldByMembers: ["c1"],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguousRows[0]?.reason).toBe(
      "ANOTHER_MEMBER_HOLDS_THE_CONTACT",
    );
  });

  it("refuses when two unlinked members share the address", async () => {
    // The family case: a dependant carries the parent's address, and nothing
    // here may decide which of them the one contact belongs to.
    givenTree({
      members: [member(), member({ id: "m2", firstName: "Byron" })],
      contacts: [cachedContact()],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.pushable).toBe(0);
    expect(snapshot.ambiguousRows.map((row) => row.reason)).toEqual([
      "MEMBERS_SHARE_THE_EMAIL_ADDRESS",
      "MEMBERS_SHARE_THE_EMAIL_ADDRESS",
    ]);
  });

  it("refuses when several Xero contacts carry the address", async () => {
    givenTree({
      members: [member()],
      contacts: [cachedContact(), cachedContact({ contactId: "c2" })],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguousRows[0]).toMatchObject({
      reason: "SEVERAL_XERO_CONTACTS_SHARE_THE_EMAIL",
      xeroContactIds: ["c1", "c2"],
    });
  });

  it("refuses when the one contact on the address carries another name", async () => {
    givenTree({
      members: [member()],
      contacts: [
        cachedContact({ name: "Grace Hopper", firstName: "Grace", lastName: "Hopper" }),
      ],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguousRows[0]?.reason).toBe("XERO_CONTACT_NAME_DIFFERS");
  });
});

describe("the run (#2939)", () => {
  it("resolves every member through the one contact funnel", async () => {
    givenTree({ members: [member()] });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
      createdByMemberId: "admin-1",
    });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledWith("m1", {
      createdByMemberId: "admin-1",
      requireAuthoritativeMatch: true,
    });
    expect(result.processed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.done).toBe(true);
  });

  it("reports a LINK as a link rather than as a new customer", async () => {
    givenTree({ members: [member()] });
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
      metadata: { linkedVia: "email_match" },
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.linkedExisting).toBe(1);
    expect(result.created).toBe(0);
  });

  it("touches only members the operator reviewed", async () => {
    givenTree({
      members: [member(), member({ id: "m2", email: "byron@example.com" })],
    });

    await runXeroMissingContactSeedingChunk({ reviewedMemberIds: ["m1"] });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledWith("m1", {
      createdByMemberId: undefined,
      requireAuthoritativeMatch: true,
    });
  });

  it("skips a reviewed member who is no longer pushable", async () => {
    // The re-run case, and the convergence the contract asks for: a member who
    // was linked since the review is simply not in the recomputed set.
    givenTree({ members: [member({ xeroContactId: "c-existing" })] });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
    // ALREADY_DONE, not NO_LONGER_PUSHABLE: an earlier chunk of this same
    // review gave them a contact, which is the expected shape of a multi-chunk
    // run — the operator has nothing to look at here. The two were reported as
    // one number until #2939's review.
    expect(result.skipped).toEqual([{ memberId: "m1", reason: "ALREADY_DONE" }]);
    expect(result.processed).toBe(0);
  });

  it("ignores an id the census never classified as pushable", async () => {
    givenTree({ members: [member()] });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "forged-id"],
    });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual([
      { memberId: "forged-id", reason: "NO_LONGER_PUSHABLE" },
    ]);
  });

  it("bounds the chunk and reports what is left", async () => {
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
        member({ id: "m3", email: "c@example.com" }),
      ],
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2", "m3"],
      limit: 2,
    });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(2);
    expect(result.remaining).toBe(1);
    expect(result.done).toBe(false);
  });

  it("does not let one bad member stall the chunk", async () => {
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
      ],
    });
    mocks.findOrCreateXeroContact
      .mockRejectedValueOnce(new Error("Xero said no"))
      .mockResolvedValueOnce("c-new");

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2"],
    });

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.failures[0]).toMatchObject({ memberId: "m1", kind: "OTHER" });
  });

  it("names a two-homes refusal as what it is", async () => {
    givenTree({ members: [member()] });
    mocks.findOrCreateXeroContact.mockRejectedValueOnce(
      new XeroContactTwoHomesError({
        xeroContactId: "c1",
        claimedBy: { kind: "MEMBER", id: "m1" },
        heldBy: { kind: "ORGANISATION", id: "org1" },
        heldByLabel: "Tokoroa Primary School",
      }),
    );

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.failures[0]?.kind).toBe("TWO_HOMES_REFUSAL");
  });

  it("names a partial provider success as what it is", async () => {
    givenTree({ members: [member()] });
    mocks.findOrCreateXeroContact.mockRejectedValueOnce(
      new XeroContactCreatePartialSuccessError(
        "PROVIDER_CONTACT_CREATED",
        "c1",
        new Error("proof write failed"),
      ),
    );

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.failures[0]?.kind).toBe("PARTIAL_SUCCESS");
  });

  it("halts on a Xero daily limit instead of spending the chunk on it", async () => {
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
      ],
    });
    mocks.findOrCreateXeroContact.mockRejectedValueOnce(
      // The constructor takes a retry-after, not a message.
      new XeroDailyLimitError(3600),
    );

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2"],
    });

    expect(result.haltedByDailyLimit).toBe(true);
    expect(result.done).toBe(false);
    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
  });

  it("asks the environment gate BEFORE it classifies or touches anybody", async () => {
    givenTree({ members: [member()] });
    mocks.assertXeroProviderWriteAllowed.mockRejectedValueOnce(
      new Error("this installation is undeclared"),
    );

    await expect(
      runXeroMissingContactSeedingChunk({ reviewedMemberIds: ["m1"] }),
    ).rejects.toThrow("this installation is undeclared");
    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
    expect(mocks.prisma.member.findMany).not.toHaveBeenCalled();
  });
});

describe("the NAME axis, which the email axis cannot see (#2939 review)", () => {
  /*
    Xero enforces contact-name uniqueness. A census that looks only along the
    email axis therefore cannot see the collision the PROVIDER will raise: the
    create is refused, the funnel's recovery adopts the existing same-named
    contact on the normalised name alone with no email comparison, and a new
    member is silently linked to a fifteen-year-old record at another address.
    These pin both halves of the fix — seeing it here, and refusing it there.
  */
  it("hands back a member whose name an ACTIVE Xero contact already carries", async () => {
    givenTree({
      members: [member()],
      contacts: [
        cachedContact({
          contactId: "c-old",
          emailAddress: "someone.else@example.com",
        }),
      ],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.pushable).toBe(0);
    expect(snapshot.ambiguousRows[0]).toMatchObject({
      memberId: "m1",
      reason: "XERO_CONTACT_ALREADY_HAS_THIS_NAME",
      xeroContactIds: ["c-old"],
    });
  });

  it("normalises the name the way the provider-side comparison does", async () => {
    // Punctuation, case and accents are exactly what
    // `normalizeXeroContactMatchValue` folds away, and the funnel's recovery
    // compares with it — so a census using a stricter test would hand over a
    // member the recovery would then adopt on.
    givenTree({
      members: [member({ firstName: "Ada", lastName: "Lovelace" })],
      contacts: [
        cachedContact({
          contactId: "c-old",
          name: "ADA  LOVELACE",
          firstName: null,
          lastName: null,
          emailAddress: "other@example.com",
        }),
      ],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguousRows[0]?.reason).toBe(
      "XERO_CONTACT_ALREADY_HAS_THIS_NAME",
    );
  });

  it("sees a same-named contact that has NO email address at all", async () => {
    /*
      The cache read used to require a non-null address, which made every
      blank-email contact invisible to this tool — and a blank-email contact is
      precisely one that can only ever be matched by name.
    */
    givenTree({
      members: [member()],
      contacts: [cachedContact({ contactId: "c-old", emailAddress: null })],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguousRows[0]?.reason).toBe(
      "XERO_CONTACT_ALREADY_HAS_THIS_NAME",
    );
  });

  it("is NOT raised by the very contact the email axis already matched", async () => {
    // Agreement on both axes is agreement, not collision: the same record
    // arriving twice must still be a clean link.
    givenTree({ members: [member()], contacts: [cachedContact()] });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguous).toBe(0);
    expect(snapshot.pushableRows[0]).toMatchObject({
      evidence: "CACHED_CONTACT_MATCH",
      cachedXeroContactId: "c1",
    });
  });

  it("ignores an ARCHIVED same-named contact, which Xero will not refuse for", async () => {
    givenTree({
      members: [member()],
      contacts: [
        cachedContact({
          contactId: "c-old",
          contactStatus: "ARCHIVED",
          emailAddress: "other@example.com",
        }),
      ],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.ambiguous).toBe(0);
    expect(snapshot.pushableRows[0]?.evidence).toBe("NO_CACHED_MATCH");
  });
});

describe("nothing is done on an answer the provider did not give (#2939 review)", () => {
  it("asks the funnel to refuse rather than fall through", async () => {
    givenTree({ members: [member()] });

    await runXeroMissingContactSeedingChunk({ reviewedMemberIds: ["m1"] });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ requireAuthoritativeMatch: true }),
    );
  });

  it("records a failed Xero search as a failure the next run retries", async () => {
    givenTree({ members: [member()] });
    mocks.findOrCreateXeroContact.mockRejectedValueOnce(
      new XeroContactProviderAnswerUnavailableError({
        phase: "EMAIL_SEARCH",
        memberId: "m1",
        originalError: new Error("socket hang up"),
      }),
    );

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.created).toBe(0);
    expect(result.failures[0]?.kind).toBe("PROVIDER_ANSWER_UNAVAILABLE");
    // Still outstanding, because the member is exactly where they were.
    expect(result.outstandingPushable).toBe(1);
  });

  it("records a name collision the provider raised as its own kind", async () => {
    givenTree({ members: [member()] });
    mocks.findOrCreateXeroContact.mockRejectedValueOnce(
      new XeroContactProviderAnswerUnavailableError({
        phase: "DUPLICATE_NAME_RECOVERY",
        memberId: "m1",
        originalError: new Error("contact name must be unique"),
      }),
    );

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.failures[0]?.kind).toBe("NAME_ALREADY_IN_XERO");
    expect(result.linkedExisting).toBe(0);
  });

  it("fails a member the funnel linked to a contact the plan did not name", async () => {
    /*
      The divergence a plan digest CANNOT catch, because it happens inside the
      funnel after the plan already matched. Reported as a failure with both
      ids, never as "linked to a contact Xero already had".
    */
    givenTree({ members: [member()], contacts: [cachedContact()] });
    mocks.findOrCreateXeroContact.mockResolvedValueOnce("c-somebody-else");

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.linkedExisting).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.failures[0]).toMatchObject({
      memberId: "m1",
      kind: "PLAN_DIVERGED",
    });
    expect(result.failures[0]?.error).toContain("c1");
    expect(result.failures[0]?.error).toContain("c-somebody-else");
  });

  it("accepts the contact the plan DID name", async () => {
    givenTree({ members: [member()], contacts: [cachedContact()] });
    mocks.findOrCreateXeroContact.mockResolvedValueOnce("c1");
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
      metadata: { linkedVia: "email_match" },
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.failed).toBe(0);
    expect(result.linkedExisting).toBe(1);
  });
});

describe("the reviewed plan is checked, not just recorded (#2939 review)", () => {
  it("runs when the plan the operator reviewed still holds", async () => {
    givenTree({ members: [member()] });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
      reviewedPlannedDigest: await reviewedDigest(),
    });

    expect(result.processed).toBe(1);
  });

  it("refuses when what would HAPPEN changed although the member did not", async () => {
    /*
      The exact hole the unchecked digest left: the operator approves "link Jane
      to the contact Xero already has", the contact sync archives it underneath
      them, and Jane is still pushable — now as a CREATE. A membership-only
      guard sees nothing wrong and mints a brand-new contact.
    */
    givenTree({ members: [member()], contacts: [cachedContact()] });
    const reviewed = await reviewedDigest();

    givenTree({
      members: [member()],
      contacts: [cachedContact({ contactStatus: "ARCHIVED" })],
    });

    await expect(
      runXeroMissingContactSeedingChunk({
        reviewedMemberIds: ["m1"],
        reviewedPlannedDigest: reviewed,
      }),
    ).rejects.toBeInstanceOf(SeedingPlanChangedError);
    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
  });

  it("refuses BEFORE any provider call, so nothing partial is left behind", async () => {
    givenTree({ members: [member()] });

    await expect(
      runXeroMissingContactSeedingChunk({
        reviewedMemberIds: ["m1"],
        reviewedPlannedDigest: "a-digest-from-some-other-plan",
      }),
    ).rejects.toBeInstanceOf(SeedingPlanChangedError);
    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
  });

  it("does not depend on the order rows came back in", async () => {
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com", firstName: "Byron" }),
      ],
    });
    const forwards = await reviewedDigest();

    givenTree({
      members: [
        member({ id: "m2", email: "b@example.com", firstName: "Byron" }),
        member({ id: "m1", email: "a@example.com" }),
      ],
    });

    expect(await reviewedDigest()).toBe(forwards);
  });
});

describe("the chunk is sized from what a member really costs (#2939 review)", () => {
  it("uses the two-call size when contact grouping is off", async () => {
    givenTree({ members: [member()], groupingMode: "NONE" });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.chunkSize).toBe(DEFAULT_SEEDING_CHUNK);
  });

  it("uses the SMALLER size when grouping is on and the funnel's tail runs", async () => {
    /*
      The funnel's tail runs a managed-group sync that short-circuits before any
      provider call only when the mode is NONE; otherwise it costs a getContact
      per member plus group calls. A flat 25 was >=75 calls against a
      60-per-minute budget — guaranteed to trip the limit, not "far inside" it.
    */
    givenTree({ members: [member()], groupingMode: "MEMBERSHIP_TYPE" });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.chunkSize).toBe(DEFAULT_SEEDING_CHUNK_WITH_GROUPING);
    expect(snapshot.chunkSize).toBeLessThan(DEFAULT_SEEDING_CHUNK);
  });

  it("keeps every size inside half a minute of Xero's budget", async () => {
    // The arithmetic, not the literals: 60 calls a minute, half of it spent.
    expect(DEFAULT_SEEDING_CHUNK * 2).toBeLessThanOrEqual(30);
    expect(DEFAULT_SEEDING_CHUNK_WITH_GROUPING * 4).toBeLessThanOrEqual(30);
  });

  it("stops on its wall-clock budget and returns what it did", async () => {
    /*
      A route killed by its host's timeout loses the WHOLE result — the summary
      audit row is written after the run returns — while every contact it
      created stays in Xero. `elapsedMs` is a seam because `Date.now()` is
      frozen for every test in this repository, so a real deadline could never
      expire here (docs/TESTING.md).
    */
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
        member({ id: "m3", email: "c@example.com" }),
      ],
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2", "m3"],
      elapsedMs: () => 999_999,
    });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
    expect(result.haltedByTimeBudget).toBe(true);
    expect(result.done).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(2);
  });

  it("always makes progress, however long the first member takes", async () => {
    givenTree({ members: [member()] });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
      elapsedMs: () => 999_999,
    });

    expect(result.processed).toBe(1);
  });
});

describe("what the operator is told afterwards (#2939 review)", () => {
  it("names every member it touched and the contact they ended up on", async () => {
    givenTree({ members: [member()], contacts: [cachedContact()] });
    mocks.findOrCreateXeroContact.mockResolvedValueOnce("c1");
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
      metadata: { linkedVia: "email_match" },
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.outcomes).toEqual([
      {
        memberId: "m1",
        memberName: "Ada Lovelace",
        memberEmail: "ada@example.com",
        outcome: "linked",
        xeroContactId: "c1",
        plannedEvidence: "CACHED_CONTACT_MATCH",
        kind: null,
        error: null,
      },
    ]);
  });

  it("names a FAILED member, with the kind that says what to do", async () => {
    givenTree({ members: [member()] });
    mocks.findOrCreateXeroContact.mockRejectedValueOnce(
      new XeroContactCreatePartialSuccessError(
        "PROVIDER_CONTACT_CREATED",
        "c1",
        new Error("proof write failed"),
      ),
    );

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.outcomes[0]).toMatchObject({
      memberName: "Ada Lovelace",
      outcome: "failed",
      kind: "PARTIAL_SUCCESS",
    });
  });

  it("separates a member an earlier chunk did from one that stopped being pushable", async () => {
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com", xeroContactId: "c-done" }),
        member({ id: "m2", email: "b@example.com", lastName: "   " }),
      ],
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2"],
    });

    expect(result.skipped).toEqual([
      { memberId: "m1", reason: "ALREADY_DONE" },
      { memberId: "m2", reason: "NO_LONGER_PUSHABLE" },
    ]);
  });

  it("counts a failed member as still outstanding on BOTH exits", async () => {
    /*
      It used to be computed one way on the daily-limit halt and another way on
      the normal path, so the same failed member was outstanding in one branch
      and done in the other.
    */
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
      ],
    });
    mocks.findOrCreateXeroContact
      .mockRejectedValueOnce(new Error("Xero said no"))
      .mockResolvedValueOnce("c-new");

    const normal = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2"],
    });
    expect(normal.remaining).toBe(1);
    expect(normal.outstandingPushable).toBe(1);

    vi.clearAllMocks();
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
      ],
    });
    mocks.prisma.xeroObjectLink.findFirst.mockResolvedValue({
      metadata: { linkedVia: "created" },
    });
    mocks.assertXeroProviderWriteAllowed.mockResolvedValue(undefined);
    mocks.findOrCreateXeroContact
      .mockRejectedValueOnce(new Error("Xero said no"))
      .mockRejectedValueOnce(new XeroDailyLimitError(3600));

    const halted = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "m2"],
    });
    expect(halted.haltedByDailyLimit).toBe(true);
    expect(halted.remaining).toBe(2);
    expect(halted.outstandingPushable).toBe(2);
  });

  it("reports what is outstanding in the POPULATION, not just in the reviewed slice", async () => {
    /*
      Past the row limit the two are different numbers, and reporting only the
      reviewed one is how the button said "next 25 of 900" while the result said
      "475 still to do" on the same screen.
    */
    givenTree({
      members: [
        member({ id: "m1", email: "a@example.com" }),
        member({ id: "m2", email: "b@example.com" }),
        member({ id: "m3", email: "c@example.com" }),
      ],
    });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1"],
    });

    expect(result.remaining).toBe(0);
    expect(result.outstandingPushable).toBe(2);
    expect(result.done).toBe(true);
  });
});

describe("cache freshness is a question about AGE (#2939 review)", () => {
  it("reports how old the cached contact list is", async () => {
    givenTree({
      members: [member()],
      syncedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.contactCacheAgeHours).toBe(5);
    expect(snapshot.contactCacheStale).toBe(false);
  });

  it("calls a cache old enough to mislead STALE", async () => {
    // Staleness is exactly what turns a "no cached match" row into a duplicate:
    // a contact added in Xero since the sync looks like no contact at all.
    givenTree({
      members: [member()],
      syncedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.contactCacheStale).toBe(true);
    expect(snapshot.contactCacheAgeHours).toBe(30 * 24);
  });
});

describe("the two exclusions that were being reported wrongly (#2939 review)", () => {
  it("says an inheritance-lost dependant LOST their address", async () => {
    /*
      The general placeholder predicate accepts every address the specific one
      does, so testing it first swallowed this reason entirely — and "lost the
      address they used to inherit" is somebody's arrangement having broken,
      which reads nothing like "never had one".
    */
    givenTree({
      members: [member({ email: "inheritance-lost-abc@inheritance-lost.invalid" })],
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("INHERITED_ADDRESS_LOST");
  });

  it("excludes a SCHOOL request whose school name is genuinely null", async () => {
    /*
      The read selected converted requests by organisation-or-name, while the
      request type enum has a school variant — so a school request carrying
      neither column escaped the exclusion entirely, and the invented contact
      record was offered up as an ordinary person.
    */
    givenTree({ members: [member()] });
    mocks.prisma.bookingRequest.findMany.mockImplementation(async (args: {
      where?: { OR?: Array<Record<string, unknown>> };
    }) => {
      const clauses = args?.where?.OR ?? [];
      const readsTheType = clauses.some(
        (clause) => (clause as { type?: string }).type === "SCHOOL",
      );
      return readsTheType ? [{ convertedMemberId: "m1" }] : [];
    });

    const snapshot = await getXeroMissingContactSnapshot();

    expect(snapshot.excludedRows[0]?.reason).toBe("SCHOOL_BOOKING_CONTACT");
  });
});
