// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the call sites themselves.
//
// Two kinds of test live here, and both are needed.
//
// BEHAVIOURAL, through `admin-booking-copy.ts`. It is the smallest of the four
// persisting paths — no HTTP, no pricing, no capacity lock — which makes it the
// right place to prove the properties every persisting path shares: the consent
// row is re-stamped rather than inherited, the send happens only AFTER the write
// has committed, and a notification failure cannot fail or roll back a booking.
//
// STRUCTURAL, read off the real source files. Three of MG2's rules cannot be
// observed from behaviour at all:
//   * a settings read must not be inside a booking transaction — a read in the
//     wrong place gives the same answer, it just holds a lock while doing it;
//   * `group-booking.ts` must keep passing NO options (MG1-D-a) — indistinguishable
//     at runtime from passing `false`, until somebody changes the default;
//   * the quote paths must not write consent columns — a quote writes no rows, so
//     "it wrote the wrong thing" is not something a passing quote can reveal.
// For those, reading the source is not a shortcut; it is the only honest test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  createDraftBooking: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
  loadMemberGuestSettings: vi.fn(),
  sendNotifications: vi.fn(),
  logAudit: vi.fn(),
  loggerError: vi.fn(),
  familyGroupMemberFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    familyGroupMember: { findMany: h.familyGroupMemberFindMany },
    member: { findMany: h.memberFindMany },
  },
}));
vi.mock("@/lib/booking-create", () => ({
  createDraftBooking: h.createDraftBooking,
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: h.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/member-guest-settings", () => ({
  loadMemberGuestSettings: h.loadMemberGuestSettings,
}));
vi.mock("@/lib/member-guest-consent-notifications", () => ({
  sendMemberGuestAddNotifications: h.sendNotifications,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.loggerError },
}));

import type { MemberGuestConsentStatus } from "@prisma/client";

import { copyBookingToDraft } from "@/lib/admin-booking-copy";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";

const SOURCE_OWNER = "m-owner";
const OUTSIDER = "m-outsider";
const ADMIN = "m-admin";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The source booking, whose cross-family guest row already carries a
 * TARGET_APPROVED consent — the member said yes to THAT stay.
 */
function sourceBooking() {
  return {
    id: "bk-source",
    memberId: SOURCE_OWNER,
    deletedAt: null,
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    notes: null,
    member: { id: SOURCE_OWNER, active: true },
    guests: [
      {
        id: "bg-source",
        firstName: "Tam",
        lastName: "Target",
        ageTier: "ADULT",
        isMember: true,
        memberId: OUTSIDER,
        stayStart: new Date("2026-07-01T00:00:00.000Z"),
        stayEnd: new Date("2026-07-03T00:00:00.000Z"),
        consentStatus: "CONFIRMED",
        consentRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
        consentRespondedAt: new Date("2026-06-02T00:00:00.000Z"),
        consentRespondedByMemberId: OUTSIDER,
        consentExpiresAt: null,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.isEffectiveModuleEnabled.mockResolvedValue(true);
  h.loadMemberGuestSettings.mockResolvedValue({
    approvalRequired: true,
    pendingHoldExpiryDays: 5,
    openMemberSearchEnabled: false,
    openMemberSearchIncludesMinors: false,
  });
  h.bookingFindUnique.mockResolvedValue(sourceBooking());
  // OUTSIDER is in no family group with the source booking's owner, so the copy's
  // boundary computation puts them BEYOND_FAMILY.
  h.familyGroupMemberFindMany.mockResolvedValue([]);
  h.memberFindMany.mockResolvedValue([
    {
      id: OUTSIDER,
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      firstName: "Tam",
      lastName: "Target",
      accessRoles: [],
      profileCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
      detailsConfirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      detailsConfirmedByMemberId: null,
      onboardingConfirmedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);
  h.createDraftBooking.mockImplementation(async () => {
    h.order.push("commit");
    return {
      id: "bk-copy",
      status: "DRAFT",
      guests: [{ id: "bg-copy", memberId: OUTSIDER }],
    };
  });
  h.sendNotifications.mockImplementation(async () => {
    h.order.push("send");
    return { sentGuestIds: ["bg-copy"], failedGuestIds: [], unreachableGuestIds: [] };
  });
});

describe("admin booking copy — consent is not transitive", () => {
  it("re-stamps the copied cross-family guest against the copying admin instead of inheriting", async () => {
    await copyBookingToDraft({
      sourceBookingId: "bk-source",
      targetCheckIn: "2026-09-10",
      adminMemberId: ADMIN,
    });

    const guests = h.createDraftBooking.mock.calls[0][0].guests as Array<{
      memberId?: string;
      memberGuestConsent?: {
        consentStatus: MemberGuestConsentStatus | null;
        consentRequestedAt: Date | null;
        consentRespondedAt: Date | null;
        consentRespondedByMemberId: string | null;
        consentExpiresAt: Date | null;
      };
    }>;
    const copied = guests.find((guest) => guest.memberId === OUTSIDER)!;
    const columns = copied.memberGuestConsent!;

    // The SOURCE row said "the target themselves said yes, on 2 June". The copy
    // must not repeat that claim about a stay the member has never heard of.
    expect(columns.consentRespondedByMemberId).toBe(ADMIN);
    expect(columns.consentRespondedByMemberId).not.toBe(OUTSIDER);
    expect(columns.consentRequestedAt).toBeNull();
    expect(columns.consentExpiresAt).toBeNull();
    expect(classifyMemberGuestConsent(columns, OUTSIDER)).toBe("ADMIN_ASSIGNED");
    // And never a PENDING request, even though the club asks members first.
    expect(columns.consentStatus).toBe("CONFIRMED");
  });

  it("sends only AFTER the draft has committed, and tells the target they were added", async () => {
    await copyBookingToDraft({
      sourceBookingId: "bk-source",
      targetCheckIn: "2026-09-10",
      adminMemberId: ADMIN,
    });

    // The ordering IS the invariant: no provider call may sit inside a booking
    // transaction, and `createDraftBooking` owns that transaction.
    expect(h.order).toEqual(["commit", "send"]);
    expect(h.sendNotifications).toHaveBeenCalledWith({
      bookingId: "bk-copy",
      rows: [
        {
          bookingGuestId: "bg-copy",
          targetMemberId: OUTSIDER,
          notification: "ADDED_NOTICE",
        },
      ],
      actor: { kind: "ADMIN", adminMemberId: ADMIN },
    });
  });

  it("reads the module flag and the settings BEFORE the draft transaction opens", async () => {
    await copyBookingToDraft({
      sourceBookingId: "bk-source",
      targetCheckIn: "2026-09-10",
      adminMemberId: ADMIN,
    });

    expect(h.isEffectiveModuleEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      h.createDraftBooking.mock.invocationCallOrder[0],
    );
    expect(h.loadMemberGuestSettings.mock.invocationCallOrder[0]).toBeLessThan(
      h.createDraftBooking.mock.invocationCallOrder[0],
    );
  });

  it("a notification failure neither fails nor rolls back the copy", async () => {
    // The dispatcher is documented never to reject; this proves the call site does
    // not depend on that promise being kept.
    h.sendNotifications.mockRejectedValue(new Error("mailer exploded"));

    await expect(
      copyBookingToDraft({
        sourceBookingId: "bk-source",
        targetCheckIn: "2026-09-10",
        adminMemberId: ADMIN,
      }),
    ).resolves.toMatchObject({ bookingId: "bk-copy" });
    expect(h.loggerError).toHaveBeenCalled();
  });

  it("writes no consent columns and tells nobody when the module is off", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(false);

    // The copy still succeeds, and that is deliberate: this path passes
    // `skipAuthorization`, so it could ALWAYS resolve a cross-family member — that
    // was true throughout MG1 and the module flag does not change it. What the
    // flag decides is whether consent columns are written, and with the module off
    // the answer is "no columns, no notice", i.e. exactly the all-null row MG1
    // wrote. A club that never opted in sees no change through the admin paths
    // either.
    await copyBookingToDraft({
      sourceBookingId: "bk-source",
      targetCheckIn: "2026-09-10",
      adminMemberId: ADMIN,
    });

    const guests = h.createDraftBooking.mock.calls[0][0].guests as Array<
      Record<string, unknown>
    >;
    expect(guests[0]).not.toHaveProperty("memberGuestConsent");
    expect(guests[0]).not.toHaveProperty("crossFamilyMemberGuest");
    expect(h.sendNotifications).not.toHaveBeenCalled();
    // And the settings singleton is not even read.
    expect(h.loadMemberGuestSettings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structural rules that behaviour cannot show
// ---------------------------------------------------------------------------

describe("no policy read inside a booking transaction", () => {
  const SITES = [
    {
      name: "api/bookings/[id]/guests/route.ts",
      file: "src/app/api/bookings/[id]/guests/route.ts",
      transactionMarker: "await prisma.$transaction(",
    },
    {
      name: "booking-batch-modification-service.ts",
      file: "src/lib/booking-batch-modification-service.ts",
      // #2525 made this service transaction-aware: it enters its transaction
      // through withOptionalTransaction (caller tx or a fresh one), so that is
      // the boundary the policy read must precede.
      transactionMarker: "await withOptionalTransaction(",
    },
  ];

  for (const site of SITES) {
    it(`${site.name} reads the policy before it opens its transaction`, () => {
      const source = readRepoFile(site.file);
      const policyRead = source.indexOf("await loadMemberGuestAddPolicy()");
      const transaction = source.indexOf(site.transactionMarker);

      expect(policyRead).toBeGreaterThan(-1);
      expect(transaction).toBeGreaterThan(-1);
      expect(policyRead).toBeLessThan(transaction);
      // And the settings loader is never called from inside these files at all —
      // it is reached only through the policy read above.
      expect(source).not.toContain("loadMemberGuestSettings");
    });
  }

  it("the pure planner is the only member-guest call the guests route makes inside its transaction", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");
    const transaction = source.indexOf("await prisma.$transaction(");
    const inTransaction = source.slice(transaction);

    expect(inTransaction).toContain("planMemberGuestConsentWrites({");
    expect(inTransaction).not.toContain("loadMemberGuestAddPolicy");
    // The sender is loaded lazily and only after the transaction callback has
    // returned, so the import itself cannot happen under the capacity lock.
    const send = source.indexOf("sendMemberGuestAddNotifications({");
    const transactionEnd = source.indexOf("    });", source.indexOf("bookingModificationId: bookingModification.id"));
    expect(send).toBeGreaterThan(transactionEnd);
  });
});

describe("group-booking stays family-scoped (owner decision MG1-D-a)", () => {
  it("passes no resolver options, and no widening flag anywhere in the file", () => {
    const source = readRepoFile("src/lib/group-booking.ts");
    const call = source.indexOf("await resolveLinkedBookingMembers(");
    expect(call).toBeGreaterThan(-1);

    // The call and its arguments, up to the closing paren of the call.
    const callText = source.slice(call, source.indexOf(");", call) + 2);
    expect(callText).not.toContain("skipAuthorization");
    expect(callText).not.toContain("memberGuestWideningEnabled");
    // Nothing in the file may turn the widening on by another route.
    expect(source).not.toContain("memberGuestWideningEnabled");
    expect(source).not.toContain("loadMemberGuestAddPolicy");
    expect(source).not.toContain("planMemberGuestConsentWrites");
    // The reason is written down, so a future reader does not "fix" the omission.
    expect(source).toContain("MG1-D-a");
  });
});

describe("the quote paths resolve but never write", () => {
  const QUOTE_FILES = [
    "src/app/api/bookings/quote/route.ts",
    "src/app/api/bookings/[id]/modify-quote/route.ts",
  ];

  for (const file of QUOTE_FILES) {
    it(`${file} marks for D-8 and plans no consent`, () => {
      const source = readRepoFile(file);

      // Resolves a cross-family member, so the party prices correctly.
      expect(source).toContain("memberGuestWideningEnabled");
      expect(source).toContain("markCrossFamilyMemberGuests(");
      // Writes nothing: no consent plan, no consent columns, no notification.
      expect(source).not.toContain("planMemberGuestConsentWrites");
      expect(source).not.toContain("memberGuestConsent:");
      expect(source).not.toContain("sendMemberGuestAddNotifications");
      expect(source).not.toContain("bookingGuest.create");
      // And it still refuses cross-family targets neutrally (D-8).
      expect(source).toContain("crossFamilyMemberIds:");
    });
  }
});

describe("every widened call site also collapses its refusals", () => {
  // The pairing is the point: a site that widens without marking would answer a
  // stranger's occupancy, subscription status or profile in full detail.
  const WIDENED_SITES = [
    "src/app/api/bookings/route.ts",
    "src/app/api/bookings/quote/route.ts",
    "src/app/api/bookings/[id]/guests/route.ts",
    "src/app/api/bookings/[id]/modify-quote/route.ts",
    "src/lib/booking-modify-plan.ts",
    "src/lib/admin-booking-copy.ts",
  ];

  for (const file of WIDENED_SITES) {
    it(`${file} passes memberGuestWideningEnabled AND crossFamilyMemberIds`, () => {
      const source = readRepoFile(file);
      expect(source).toContain("memberGuestWideningEnabled");
      expect(source).toContain("crossFamilyMemberIds:");
      // Each one uses the boundary-returning resolver — the map-only wrapper
      // cannot supply the ids the collapse needs.
      expect(source).toContain("resolveLinkedBookingMembersWithBoundary");
    });
  }

  it("covers six of the seven call sites, and names the seventh", () => {
    // Seven call sites; six widen, and group-booking.ts is the one that must not
    // (MG1-D-a). If this count changes, the census in
    // member-guest-widening.test.ts and this list have to change together.
    expect(WIDENED_SITES).toHaveLength(6);
    const groupBooking = readRepoFile("src/lib/group-booking.ts");
    expect(groupBooking).not.toContain("memberGuestWideningEnabled");
  });
});

// ---------------------------------------------------------------------------
// The batch-modification write, exercised directly
// ---------------------------------------------------------------------------

describe("applyGuestChanges persists the planned consent columns", () => {
  const NEW_CHECK_IN = new Date("2026-09-10T00:00:00.000Z");
  const NEW_CHECK_OUT = new Date("2026-09-12T00:00:00.000Z");
  const CONSENT = {
    consentStatus: "PENDING" as const,
    consentRequestedAt: new Date("2026-08-01T09:00:00.000Z"),
    consentRespondedAt: null,
    consentRespondedByMemberId: null,
    consentExpiresAt: new Date("2026-08-06T09:00:00.000Z"),
  };

  function fakeTx() {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      tx: {
        bookingGuest: {
          create: vi.fn(async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return {
              id: `bg-${created.length}`,
              stayStart: NEW_CHECK_IN,
              stayEnd: NEW_CHECK_OUT,
              memberId: args.data.memberId ?? null,
            };
          }),
          update: vi.fn(async () => ({})),
          delete: vi.fn(async () => ({})),
        },
        bookingGuestNight: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          createMany: vi.fn(async () => ({ count: 0 })),
        },
        choreAssignment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      },
    };
  }

  const guestWithConsent = {
    firstName: "Tam",
    lastName: "Target",
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: OUTSIDER,
    stayStart: NEW_CHECK_IN,
    stayEnd: NEW_CHECK_OUT,
    memberGuestConsent: CONSENT,
    crossFamilyMemberGuest: true,
  };
  const familyGuest = {
    firstName: "Kid",
    lastName: "Booker",
    ageTier: "CHILD" as const,
    isMember: true,
    memberId: "m-kid",
    stayStart: NEW_CHECK_IN,
    stayEnd: NEW_CHECK_OUT,
  };

  const priceBreakdown = {
    totalPriceCents: 2000,
    guests: [
      { priceCents: 1000, perNightCents: [500, 500], nightDates: [NEW_CHECK_IN] },
      { priceCents: 1000, perNightCents: [500, 500], nightDates: [NEW_CHECK_IN] },
    ],
  };

  it("writes the columns for a cross-family add and nothing for a family one", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = fakeTx();

    await applyGuestChanges(
      tx as unknown as Parameters<typeof applyGuestChanges>[0],
      {
        bookingId: "bk-1",
        newCheckIn: NEW_CHECK_IN,
        newCheckOut: NEW_CHECK_OUT,
        removedGuests: [],
        remainingGuests: [],
        proposedRemainingGuests: [],
        normalizedAddGuests: [guestWithConsent, familyGuest],
        priceBreakdown,
        inProgressPlan: null,
      },
    );

    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject(CONSENT);
    expect(classifyMemberGuestConsent(
      created[0] as unknown as Parameters<typeof classifyMemberGuestConsent>[0],
      OUTSIDER,
    )).toBe("AWAITING_TARGET");
    // Neither the marker nor the wrapper object is ever a database column.
    expect(created[0]).not.toHaveProperty("crossFamilyMemberGuest");
    expect(created[0]).not.toHaveProperty("memberGuestConsent");
    // The family row is written exactly as it was before MG2.
    expect(created[1]).not.toHaveProperty("consentStatus");
  });

  it("writes them on the in-progress-edit add path too", async () => {
    // The in-progress path builds its guests through buildInProgressGuestRangePlan
    // rather than from normalizedAddGuests, which is exactly how it could have
    // become the one add that quietly wrote a consent-free cross-family row.
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = fakeTx();

    await applyGuestChanges(
      tx as unknown as Parameters<typeof applyGuestChanges>[0],
      {
        bookingId: "bk-1",
        newCheckIn: NEW_CHECK_IN,
        newCheckOut: NEW_CHECK_OUT,
        removedGuests: [],
        remainingGuests: [],
        proposedRemainingGuests: [],
        normalizedAddGuests: undefined,
        priceBreakdown,
        inProgressPlan: {
          proposedExistingGuests: [],
          proposedAddedGuests: [
            {
              guest: { ...guestWithConsent, rateMembershipTypeId: "mt-1" },
              stayStart: NEW_CHECK_IN,
              stayEnd: NEW_CHECK_OUT,
              priceCents: 1000,
            },
          ],
          remainingGuests: [],
          removedGuests: [],
          newTotalPriceCents: 1000,
          newDiscountCents: 0,
          newPromoAdjustmentCents: 0,
          newFinalPriceCents: 1000,
          priceDiffCents: 0,
          capacityGuestRanges: [],
        } as unknown as Parameters<typeof applyGuestChanges>[1]["inProgressPlan"],
      },
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject(CONSENT);
    expect(classifyMemberGuestConsent(
      created[0] as unknown as Parameters<typeof classifyMemberGuestConsent>[0],
      OUTSIDER,
    )).toBe("AWAITING_TARGET");
  });
});

describe("the add-guests route write", () => {
  it("spreads the planned consent columns onto the row it creates", () => {
    // Behaviourally this route needs the whole HTTP + pricing + capacity stack; the
    // one line that matters is asserted directly instead, next to the create call.
    const source = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");
    const create = source.indexOf("tx.bookingGuest.create({");
    expect(create).toBeGreaterThan(-1);
    const createBlock = source.slice(create, source.indexOf("createdGuests.push", create));
    expect(createBlock).toContain("...(normalizedNewGuests[i].memberGuestConsent ?? {})");
  });
});
