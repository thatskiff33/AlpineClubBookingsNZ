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
  const actual =
    await importOriginal<typeof import("@/lib/xero-environment-write-gate")>();
  return { ...actual, assertXeroProviderWriteAllowed: mocks.assertXeroProviderWriteAllowed };
});
/*
  PARTIAL, through `importOriginal`, on purpose. Only the funnel is replaced;
  `getMissingFieldsForXeroContactCreate` and
  `XeroContactCreatePartialSuccessError` come through real, so the create gate
  this census applies is the SAME function the payload builder applies
  (INV-SSOT) rather than a second copy written to agree with it.
*/
vi.mock("@/lib/xero-contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-contacts")>();
  return { ...actual, findOrCreateXeroContact: mocks.findOrCreateXeroContact };
});

import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { XeroContactTwoHomesError } from "@/lib/xero-contact-home";
import { XeroContactCreatePartialSuccessError } from "@/lib/xero-contacts";
import {
  getXeroMissingContactSnapshot,
  runXeroMissingContactSeedingChunk,
} from "@/lib/xero-missing-contact-seeding";

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
}) {
  mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(
    input.syncedAt === null
      ? null
      : { lastSuccessfulSyncAt: input.syncedAt ?? SYNCED_AT },
  );
  mocks.prisma.member.findMany.mockImplementation(async (args: {
    where?: { xeroContactId?: { in?: string[] } };
  }) => {
    // The held-by read is the only one keyed on a contact-id set.
    if (args?.where?.xeroContactId?.in) {
      return (input.heldByMembers ?? []).map((contactId) => ({
        xeroContactId: contactId,
      }));
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
    where?: { contactStatus?: string };
  }) =>
    (input.contacts ?? []).filter(
      (contact) =>
        args?.where?.contactStatus === undefined ||
        contact.contactStatus === args.where.contactStatus,
    ),
  );
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
    expect(result.skippedNoLongerPushable).toEqual(["m1"]);
    expect(result.processed).toBe(0);
  });

  it("ignores an id the census never classified as pushable", async () => {
    givenTree({ members: [member()] });

    const result = await runXeroMissingContactSeedingChunk({
      reviewedMemberIds: ["m1", "forged-id"],
    });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
    expect(result.skippedNoLongerPushable).toEqual(["forged-id"]);
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
      new XeroDailyLimitError("daily limit"),
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
