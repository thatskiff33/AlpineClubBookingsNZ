/**
 * ALP-719 (`INV-MCP-006`): the Bookings & Beds booking actions an officer's AI
 * app connection may run (`/api/admin/bookings/**`): the booking list and
 * search, the on-behalf pickers, and the officer tools on one booking. Each
 * route answers the browser as before; the connection gets exactly the
 * action's `returns` fields (`expectActionContract`). Every handler runs twice
 * (connection, then browser), so each service double answers both runs.
 *
 * Fixtures carry fields the shapes drop (emails, provider ids, other members'
 * ids, internal audit names), so each test proves the drop and pins the
 * browser's answer with them still in it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    booking: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    bedAllocation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    createAuditLog: vi.fn(),
    // Capacity and lodges
    getMonthAvailability: vi.fn(),
    getLodgeCapacity: vi.fn(),
    acquireLodgeCapacityLock: vi.fn(),
    checkCapacity: vi.fn(),
    holdingConflicts: vi.fn(),
    overriddenConflicts: vi.fn(),
    countActiveLodges: vi.fn(),
    defaultLodgeId: vi.fn(),
    // On-behalf pickers
    resolveMemberFamily: vi.fn(),
    partnerSharingCandidates: vi.fn(),
    suggestContacts: vi.fn(),
    createContact: vi.fn(),
    memberGuestGate: vi.fn(),
    memberGuestsByEmail: vi.fn(),
    memberGuestsByName: vi.fn(),
    auditMemberGuestResolve: vi.fn(),
    auditMemberGuestSearch: vi.fn(),
    // One booking
    flags: vi.fn(),
    clubToday: vi.fn(),
    clubFormat: vi.fn(),
    multiPromoCodes: vi.fn(),
    workPartyEvents: vi.fn(),
    workPartyFacts: vi.fn(),
    workPartyAddEligibility: vi.fn(),
    workPartyRemovalEligibility: vi.fn(),
    copyBooking: vi.fn(),
    resendAdditionalPayment: vi.fn(),
    reconcileGlobal: vi.fn(),
    reconcileLodge: vi.fn(),
    postingContext: vi.fn(),
    enqueueHosting: vi.fn(),
    settleHosting: vi.fn(),
    sendConfirmed: vi.fn(),
    sendPlaceRestored: vi.fn(),
    sendFreshCopy: vi.fn(),
    setNoEmails: vi.fn(),
    writeRequestedRoom: vi.fn(),
    strandReport: vi.fn(),
    waitlistPosition: vi.fn(),
    processWaitlist: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  getMonthAvailability: h.getMonthAvailability,
  getLodgeCapacity: h.getLodgeCapacity,
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: h.checkCapacity,
  findOverlappingCapacityHoldingBookings: h.holdingConflicts,
  findOverlappingOverriddenNonHoldingBookings: h.overriddenConflicts,
}));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodges")),
  countActiveLodges: h.countActiveLodges,
  getDefaultLodgeId: h.defaultLodgeId,
}));
vi.mock("@/lib/resolve-member-family", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/resolve-member-family")),
  resolveMemberFamily: h.resolveMemberFamily,
}));
vi.mock("@/lib/double-bed-sharing", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/double-bed-sharing")),
  listBookingPartnerSharingCandidates: h.partnerSharingCandidates,
}));
vi.mock("@/lib/non-member-contact", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/non-member-contact")),
  suggestNonMemberContacts: h.suggestContacts,
  createNonMemberContact: h.createContact,
}));
vi.mock("@/lib/member-guest-find-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-find-service")),
  loadMemberGuestFindGate: h.memberGuestGate,
  resolveMemberGuestCandidatesByEmail: h.memberGuestsByEmail,
  searchMemberGuestCandidatesByName: h.memberGuestsByName,
  auditMemberGuestResolve: h.auditMemberGuestResolve,
  auditMemberGuestSearch: h.auditMemberGuestSearch,
}));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: h.flags,
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTodayDateOnlyInstant: h.clubToday,
}));
vi.mock("@/lib/club-format-server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-format-server")),
  clubFormatValues: h.clubFormat,
}));
vi.mock("@/lib/promo-redemption-slot", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/promo-redemption-slot")),
  multiPromoCodesEnabled: h.multiPromoCodes,
}));
vi.mock("@/lib/work-party", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party")),
  findActiveWorkPartyEventsForRange: h.workPartyEvents,
}));
vi.mock("@/lib/work-party-booking-facts", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party-booking-facts")),
  readWorkPartyBookingFacts: h.workPartyFacts,
}));
vi.mock("@/lib/work-party-booking-correction", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party-booking-correction")),
  workPartyBookingEligibility: h.workPartyAddEligibility,
  workPartyRemovalEligibility: h.workPartyRemovalEligibility,
}));
vi.mock("@/lib/admin-booking-copy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-booking-copy")),
  copyBookingToDraft: h.copyBooking,
}));
vi.mock("@/lib/additional-payment-resend-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/additional-payment-resend-service")),
  resendAdditionalPaymentEmail: h.resendAdditionalPayment,
}));
vi.mock("@/lib/bed-allocation-lifecycle", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-lifecycle")),
  reconcileBedAllocationsForBookingWithGlobalLockHeld: h.reconcileGlobal,
  reconcileBedAllocationsForBookingWithLodgeLockHeld: h.reconcileLodge,
}));
vi.mock("@/lib/member-money/doors", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/doors")),
  resolveBookingMoneyPostingContext: h.postingContext,
}));
vi.mock("@/lib/adult-member-hosting-review", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/adult-member-hosting-review")),
  enqueueOwnHostingCoverageReevaluation: h.enqueueHosting,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/adult-member-hosting-coverage-drain")),
  settleHostingCoverageAfterCommit: h.settleHosting,
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email")),
  sendBookingConfirmedEmail: h.sendConfirmed,
  sendWaitlistPlaceRestoredEmail: h.sendPlaceRestored,
}));
vi.mock("@/lib/booking-fresh-email-copy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-fresh-email-copy")),
  sendBookingFreshEmailCopy: h.sendFreshCopy,
}));
vi.mock("@/lib/booking-no-emails-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-no-emails-service")),
  setBookingNoEmails: h.setNoEmails,
}));
vi.mock("@/lib/requested-room-write", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/requested-room-write")),
  writeRequestedRoom: h.writeRequestedRoom,
}));
vi.mock("@/lib/waitlist-return-contract", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/waitlist-return-contract")),
  findUnresolvedWaitlistStrandReport: h.strandReport,
}));
vi.mock("@/lib/waitlist-queue", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/waitlist-queue")),
  getWaitlistPositionOf: h.waitlistPosition,
}));
vi.mock("@/lib/waitlist", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/waitlist")),
  processWaitlistForDates: h.processWaitlist,
}));

import { GET as listForMonth } from "@/app/api/admin/bookings/route";
import { GET as getMemberFamily } from "@/app/api/admin/bookings/eligible-family/route";
import {
  GET as searchContacts,
  POST as createContact,
} from "@/app/api/admin/bookings/non-member-contact/route";
import { GET as searchBookings } from "@/app/api/admin/bookings/search/route";
import { POST as sendReminder } from "@/app/api/admin/bookings/[id]/additional-payment-reminder/route";
import {
  DELETE as releaseCapacityHold,
  POST as placeCapacityHold,
} from "@/app/api/admin/bookings/[id]/capacity-hold/route";
import { POST as copyBooking } from "@/app/api/admin/bookings/[id]/copy/route";
import { GET as getOwnerFamily } from "@/app/api/admin/bookings/[id]/eligible-family/route";
import { POST as exclusiveHold } from "@/app/api/admin/bookings/[id]/exclusive-hold/route";
import { POST as forceConfirm } from "@/app/api/admin/bookings/[id]/force-confirm/route";
import { POST as freshEmailCopy } from "@/app/api/admin/bookings/[id]/fresh-email-copy/route";
import {
  GET as memberGuestsByName,
  POST as memberGuestByEmail,
} from "@/app/api/admin/bookings/[id]/member-guest-candidates/route";
import { POST as noEmails } from "@/app/api/admin/bookings/[id]/no-emails/route";
import {
  DELETE as clearRequestedRoom,
  PUT as setRequestedRoom,
} from "@/app/api/admin/bookings/[id]/requested-room/route";
import { POST as returnToWaitlist } from "@/app/api/admin/bookings/[id]/return-to-waitlist/route";
import { GET as workPartyOptions } from "@/app/api/admin/bookings/[id]/work-party/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { BOOKINGS_BOOKING_MCP_ACTIONS } from "@/lib/mcp/catalogue/bookings-bookings";

const OFFICER = "officer-1";
const BOOKINGS_EDIT = { permission: { area: "bookings", level: "edit" } };

function day(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

/** What the browser receives: the fixture after a JSON round trip. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** `value` without the named fields: what a connection is sent of it. */
function omit<T extends object>(value: T, ...keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as Partial<T>;
}

/** The argument a route's `prisma.booking.findUnique` is asked with. */
type FindUniqueArgs = { select?: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession(OFFICER) });
  // Interactive transactions run against the same doubles.
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.prisma.$executeRaw.mockResolvedValue(1);
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.defaultLodgeId.mockResolvedValue("lodge-1");
  h.createAuditLog.mockResolvedValue(undefined);
  h.clubToday.mockResolvedValue(day("2026-07-01"));
  h.clubFormat.mockResolvedValue({});
  h.flags.mockResolvedValue({ workParties: true, bedAllocation: true });
});

describe("the booking actions", () => {
  it("are decided as the issue's kinds", () => {
    const kinds = Object.fromEntries(
      BOOKINGS_BOOKING_MCP_ACTIONS.map((action) => [action.id, `${action.kind}${action.preview ? "+preview" : ""}`]),
    );
    expect(kinds).toEqual({
      search_bookings: "read",
      list_bookings_for_month: "read",
      get_member_family_for_booking: "read",
      get_booking_owner_family: "read",
      search_non_member_contacts: "read",
      create_non_member_contact: "destructive",
      search_member_guest_candidates: "read",
      find_member_guest_by_email: "write",
      get_booking_work_party_options: "read",
      copy_booking_to_draft: "destructive",
      send_additional_payment_reminder: "destructive",
      place_admin_capacity_hold: "destructive",
      release_admin_capacity_hold: "destructive",
      set_exclusive_lodge_hold: "destructive",
      force_confirm_waitlisted_booking: "destructive",
      send_fresh_booking_email_copy: "destructive",
      set_booking_no_emails: "destructive",
      set_booking_requested_room: "destructive",
      clear_booking_requested_room: "destructive",
      return_booking_to_waitlist: "destructive",
    });
  });

  it("each resolve to the Bookings & Beds area by path: view for a GET, edit otherwise", () => {
    for (const action of BOOKINGS_BOOKING_MCP_ACTIONS) {
      const path = action.path.replace("[id]", "booking-1");
      expect(getAdminRouteRequirement(path, action.method), action.id).toEqual({
        area: "bookings",
        level: action.method === "GET" ? "view" : "edit",
      });
    }
  });
});

// ── The booking list and search ─────────────────────────────────────────────

describe("search_bookings", () => {
  it("answers each match without the booker's email or the payment and Xero references", async () => {
    h.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "PAID",
        deletedAt: null,
        checkIn: day("2026-08-01"),
        checkOut: day("2026-08-03"),
        updatedAt: day("2026-06-20"),
        member: { firstName: "Alex", lastName: "Smith", email: "alex@example.test" },
        organisation: null,
        payment: { id: "pay-1", xeroInvoiceId: null, manuallyMarkedPaidAt: null },
        _count: { guests: 3 },
      },
    ]);
    h.prisma.xeroObjectLink.findMany.mockResolvedValue([]);
    h.prisma.xeroSyncOperation.findMany.mockResolvedValue([{ localId: "pay-1" }]);

    const { connection, browser } = await expectActionContract({
      actionId: "search_bookings",
      handler: searchBookings,
      args: { q: "Smith" },
    });

    // Bare `requireAdmin()`: a GET here infers bookings view (pinned above).
    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.prisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 8 }));
    const projected = {
      id: "booking-1",
      memberName: "Alex Smith",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      status: "PAID",
      deletedAt: null,
      guestCount: 3,
    };
    expect(connection).toEqual({ bookings: [projected] });
    expect(browser).toEqual({
      bookings: [
        {
          ...projected,
          memberEmail: "alex@example.test",
          paymentId: "pay-1",
          xeroInvoiceId: null,
          canForceSyncInvoice: false,
          forceSyncInvoiceReason: "This booking invoice is already queued for background processing.",
        },
      ],
    });
  });
});

describe("list_bookings_for_month", () => {
  it("answers the month's bookings and one lodge's free beds per night", async () => {
    h.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        memberId: "member-7",
        lodgeId: "lodge-1",
        status: "PAID",
        deletedAt: null,
        finalPriceCents: 24000,
        checkIn: day("2026-08-01"),
        checkOut: day("2026-08-03"),
        member: { firstName: "Alex", lastName: "Smith" },
        organisation: null,
        guests: [
          { stayStart: null, stayEnd: null },
          { stayStart: null, stayEnd: null },
        ],
      },
    ]);
    h.getMonthAvailability.mockResolvedValue(new Map([["2026-08-01", 4]]));
    h.getLodgeCapacity.mockResolvedValue(30);

    const { connection, browser } = await expectActionContract({
      actionId: "list_bookings_for_month",
      handler: listForMonth,
      args: { calendarMonth: "2026-08", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.getMonthAvailability).toHaveBeenCalledWith("lodge-1", 2026, 7);
    // The answer is built field by field, so both get all of it.
    const answer = {
      bookings: [
        {
          id: "booking-1",
          memberName: "Alex Smith",
          checkIn: "2026-08-01",
          checkOut: "2026-08-03",
          status: "PAID",
          deletedAt: null,
          guestCount: 2,
        },
      ],
      availability: { "2026-08-01": 26 },
    };
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });
});

// ── On-behalf pickers ───────────────────────────────────────────────────────

/** One member's family, with fields the picker shape drops. */
function familyFixture() {
  return {
    familyGroupId: "family-1",
    familyGroupName: "Smith family",
    familyGroupIds: ["family-1"],
    familyMembers: [
      {
        id: "member-8",
        firstName: "Sam",
        lastName: "Smith",
        ageTier: "CHILD",
        relationship: "CHILD",
        email: "sam@example.test",
      },
    ],
    ownDependants: [{ id: "member-9", firstName: "Kit", lastName: "Smith", dateOfBirth: day("2020-02-02") }],
  };
}

const PROJECTED_FAMILY = {
  familyGroupId: "family-1",
  familyGroupName: "Smith family",
  familyGroupIds: ["family-1"],
  familyMembers: [{ id: "member-8", firstName: "Sam", lastName: "Smith", ageTier: "CHILD", relationship: "CHILD" }],
  ownDependants: [{ id: "member-9", firstName: "Kit", lastName: "Smith" }],
};

describe("get_member_family_for_booking", () => {
  it("answers the named member's family group and dependants", async () => {
    h.resolveMemberFamily.mockResolvedValue(familyFixture());

    const { connection, browser } = await expectActionContract({
      actionId: "get_member_family_for_booking",
      handler: getMemberFamily,
      args: { forMemberId: "member-7" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.resolveMemberFamily).toHaveBeenCalledWith("member-7");
    expect(connection).toEqual(PROJECTED_FAMILY);
    expect(browser).toEqual(asJson(familyFixture()));
  });
});

describe("get_booking_owner_family", () => {
  it("answers the booking owner's family, never the officer's, and the partner-sharers", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "member-7" });
    h.resolveMemberFamily.mockResolvedValue(familyFixture());
    const partner = {
      id: "member-20",
      firstName: "Jo",
      lastName: "Partner",
      partnerOfMemberId: "member-8",
      partnerOfName: "Sam Smith",
      email: "jo@example.test",
    };
    h.partnerSharingCandidates.mockResolvedValue([partner]);

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_owner_family",
      handler: getOwnerFamily,
      args: { id: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.resolveMemberFamily).toHaveBeenCalledWith("member-7");
    expect(h.resolveMemberFamily).not.toHaveBeenCalledWith(OFFICER);
    expect(h.partnerSharingCandidates).toHaveBeenCalledWith("booking-1");
    expect(connection).toEqual({
      ...PROJECTED_FAMILY,
      partnerSharingCandidates: [
        {
          id: "member-20",
          firstName: "Jo",
          lastName: "Partner",
          partnerOfMemberId: "member-8",
          partnerOfName: "Sam Smith",
        },
      ],
    });
    expect(browser).toEqual(asJson({ ...familyFixture(), partnerSharingCandidates: [partner] }));
  });
});

describe("search_non_member_contacts", () => {
  it("answers matching contacts with the address and phone the officer matches on", async () => {
    const suggestion = {
      id: "contact-1",
      firstName: "Wiremu",
      lastName: "Walker",
      email: "wiremu@example.test",
      isPlaceholderEmail: false,
      role: "NON_MEMBER",
      phoneNumber: "021 000 000",
      bookingCount: 2,
      createdAt: day("2026-01-01"),
    };
    h.suggestContacts.mockResolvedValue([suggestion]);

    const { connection, browser } = await expectActionContract({
      actionId: "search_non_member_contacts",
      handler: searchContacts,
      args: { email: "wiremu@" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.suggestContacts).toHaveBeenCalledWith({ email: "wiremu@", name: null });
    expect(connection).toEqual({ contacts: [omit(suggestion, "createdAt")] });
    expect(browser).toEqual(asJson({ contacts: [suggestion] }));
  });
});

describe("create_non_member_contact", () => {
  it("creates the contact as the signed-in officer and answers its id, names and email", async () => {
    const contact = {
      id: "contact-2",
      firstName: "Wiremu",
      lastName: "Walker",
      email: "wiremu@example.test",
      isPlaceholderEmail: false,
      role: "NON_MEMBER",
    };
    h.createContact.mockResolvedValue(contact);

    const { connection, browser } = await expectActionContract({
      actionId: "create_non_member_contact",
      handler: createContact,
      args: { firstName: "Wiremu", lastName: "Walker", email: "wiremu@example.test" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.createContact).toHaveBeenCalledWith({
      firstName: "Wiremu",
      lastName: "Walker",
      email: "wiremu@example.test",
      noEmail: false,
      actorMemberId: OFFICER,
    });
    expect(connection).toEqual({ contact: omit(contact, "role"), reused: false });
    expect(browser).toEqual({ contact, reused: false });
  });
});

const GATE_SETTINGS = { searchEnabled: true };

function memberGuestCandidate() {
  return { memberId: "member-30", firstName: "Ana", lastName: "Smith", ageTier: "ADULT", email: "ana@example.test" };
}

const PROJECTED_CANDIDATE = { memberId: "member-30", firstName: "Ana", lastName: "Smith", ageTier: "ADULT" };

describe("search_member_guest_candidates", () => {
  it("searches as an officer by name and records the search", async () => {
    h.memberGuestGate.mockResolvedValue({ ok: true, settings: GATE_SETTINGS });
    h.memberGuestsByName.mockResolvedValue({ candidates: [memberGuestCandidate()], truncated: true });

    const { connection, browser } = await expectActionContract({
      actionId: "search_member_guest_candidates",
      handler: memberGuestsByName,
      args: { id: "booking-1", q: "Sm" },
    });

    // Bare `requireAdmin()` (bookings view); the route then asks for Membership view itself.
    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.memberGuestsByName).toHaveBeenCalledWith({ q: "Sm", settings: GATE_SETTINGS, audience: "ADMIN" });
    expect(h.auditMemberGuestSearch).toHaveBeenCalledWith(
      expect.objectContaining({ actorMemberId: OFFICER, q: "Sm", resultCount: 1, truncated: true }),
    );
    expect(connection).toEqual({ candidates: [PROJECTED_CANDIDATE], truncated: true });
    expect(browser).toEqual({ candidates: [memberGuestCandidate()], truncated: true });
  });
});

describe("find_member_guest_by_email", () => {
  it("looks the normalised address up and records the lookup", async () => {
    h.memberGuestGate.mockResolvedValue({ ok: true, settings: GATE_SETTINGS });
    h.memberGuestsByEmail.mockResolvedValue({ candidates: [memberGuestCandidate()] });

    const { connection, browser } = await expectActionContract({
      actionId: "find_member_guest_by_email",
      handler: memberGuestByEmail,
      args: { id: "booking-1", email: " Ana@Example.test " },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.memberGuestsByEmail).toHaveBeenCalledWith({ email: "ana@example.test" });
    expect(h.auditMemberGuestResolve).toHaveBeenCalledWith(
      expect.objectContaining({ actorMemberId: OFFICER, candidates: [{ memberId: "member-30" }] }),
    );
    expect(connection).toEqual({ candidates: [PROJECTED_CANDIDATE] });
    expect(browser).toEqual({ candidates: [memberGuestCandidate()] });
  });
});

// ── Officer tools on one booking ────────────────────────────────────────────

describe("get_booking_work_party_options", () => {
  it("answers the current work party, whether it can come off, and the overlapping open ones", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({
      status: "PAID",
      lodgeId: "lodge-1",
      memberId: "member-7",
      checkIn: day("2026-09-01"),
      checkOut: day("2026-09-03"),
    });
    h.workPartyFacts.mockResolvedValue({
      current: { id: "wp-1", name: "Spring working bee", promoCodeId: "promo-1" },
      add: { hasWorkParty: true },
      remove: { workPartyEventId: "wp-1" },
    });
    h.workPartyRemovalEligibility.mockReturnValue({ ok: false, reason: "The stay has started." });
    h.multiPromoCodes.mockResolvedValue(false);
    h.workPartyEvents.mockResolvedValue([
      {
        id: "wp-2",
        name: "Track clearing",
        startDate: day("2026-09-01"),
        endDate: day("2026-09-04"),
        discountPercent: 50,
        promoCodeId: "promo-2",
        lodge: { id: "lodge-2", name: "Tararua" },
      },
    ]);
    h.workPartyAddEligibility.mockReturnValue({ ok: true });

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_work_party_options",
      handler: workPartyOptions,
      args: { id: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith({ permission: { area: "bookings", level: "view" } });
    expect(h.workPartyFacts).toHaveBeenCalledWith(h.prisma, "booking-1", expect.anything(), OFFICER);
    const answer = {
      currentWorkParty: { id: "wp-1", name: "Spring working bee" },
      removal: { eligible: false, reason: "The stay has started." },
      workParties: [
        {
          id: "wp-2",
          name: "Track clearing",
          startDate: "2026-09-01",
          endDate: "2026-09-04",
          discountPercent: 50,
          lodgeName: "Tararua",
          eligible: true,
          reason: null,
        },
      ],
    };
    expect(connection).toEqual(answer);
    expect(browser).toEqual({
      ...answer,
      currentWorkParty: { id: "wp-1", name: "Spring working bee", promoCodeId: "promo-1" },
    });
  });
});

describe("copy_booking_to_draft", () => {
  it("copies the booking as the signed-in officer and answers the new draft", async () => {
    const draft = {
      bookingId: "booking-2",
      sourceBookingId: "booking-1",
      checkIn: "2026-09-10",
      checkOut: "2026-09-12",
      status: "DRAFT",
    };
    h.copyBooking.mockResolvedValue(draft);

    const { connection, browser } = await expectActionContract({
      actionId: "copy_booking_to_draft",
      handler: copyBooking,
      args: { id: "booking-1", checkIn: "2026-09-10" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.copyBooking).toHaveBeenCalledWith({
      sourceBookingId: "booking-1",
      targetCheckIn: "2026-09-10",
      adminMemberId: OFFICER,
    });
    expect(connection).toEqual(draft);
    expect(browser).toEqual(draft);
  });
});

describe("send_additional_payment_reminder", () => {
  it("re-sends the extra payment email and answers when and how much", async () => {
    h.resendAdditionalPayment.mockResolvedValue({
      ok: true,
      sentAt: new Date("2026-07-01T00:00:00.000Z"),
      additionalAmountCents: 2500,
      sentTo: "alex@example.test",
    });

    const { connection, browser } = await expectActionContract({
      actionId: "send_additional_payment_reminder",
      handler: sendReminder,
      args: { id: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.resendAdditionalPayment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", actorMemberId: OFFICER }),
    );
    // The answer is built field by field: the address never reaches either.
    const answer = { success: true, sentAt: "2026-07-01T00:00:00.000Z", additionalAmountCents: 2500 };
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });
});

/** A guest row as the capacity routes include it. */
function guestRow() {
  return { id: "guest-1", memberId: "member-7", ageTier: "ADULT", consentStatus: null, nights: [] };
}

/** One night over capacity at `date`. */
function overbookedCapacity(date: string) {
  return {
    available: false,
    minAvailable: -1,
    nightDetails: [{ date: day(date), occupiedBeds: 31, availableBeds: -1, wholeLodgeHeld: false }],
  };
}

describe("place_admin_capacity_hold", () => {
  it("places an overbooked hold when told to and answers the overbooked nights", async () => {
    h.prisma.booking.findUnique.mockImplementation(async (args: FindUniqueArgs) =>
      args.select
        ? { lodgeId: "lodge-1" }
        : {
            id: "booking-1",
            memberId: "member-7",
            lodgeId: "lodge-1",
            status: "PAYMENT_PENDING",
            deletedAt: null,
            adminCapacityHoldAt: null,
            originBookingRequest: null,
            checkIn: day("2026-08-01"),
            checkOut: day("2026-08-02"),
            guests: [guestRow()],
          },
    );
    h.checkCapacity.mockResolvedValue(overbookedCapacity("2026-08-01"));
    h.prisma.booking.update.mockResolvedValue({ adminCapacityHoldAt: new Date("2026-07-01T00:00:00.000Z") });

    const { connection, browser } = await expectActionContract({
      actionId: "place_admin_capacity_hold",
      handler: placeCapacityHold,
      args: { id: "booking-1", allowOverbook: true },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.acquireLodgeCapacityLock).toHaveBeenCalledWith(h.prisma, "lodge-1");
    expect(h.prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminCapacityHoldByMemberId: OFFICER, capacityOverriddenByMemberId: OFFICER }),
      }),
    );
    const answer = {
      success: true,
      overbooked: true,
      overbookDates: ["2026-08-01"],
      adminCapacityHoldAt: "2026-07-01T00:00:00.000Z",
    };
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });
});

describe("release_admin_capacity_hold", () => {
  it("releases the hold and answers success", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-7",
      status: "PAYMENT_PENDING",
      deletedAt: null,
      adminCapacityHoldAt: day("2026-06-20"),
      adminCapacityHoldByMemberId: "officer-2",
      originBookingRequest: null,
    });
    h.prisma.booking.update.mockResolvedValue({});

    const { connection, browser } = await expectActionContract({
      actionId: "release_admin_capacity_hold",
      handler: releaseCapacityHold,
      args: { id: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.prisma.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { adminCapacityHoldAt: null, adminCapacityHoldByMemberId: null },
    });
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

describe("set_exclusive_lodge_hold", () => {
  it("sets the hold and answers the overlapping bookings without their lodge", async () => {
    h.prisma.booking.findUnique.mockImplementation(async (args: FindUniqueArgs) =>
      args.select?.status
        ? {
            id: "booking-1",
            memberId: "member-7",
            lodgeId: "lodge-1",
            status: "PAID",
            deletedAt: null,
            checkIn: day("2026-08-01"),
            checkOut: day("2026-08-03"),
            wholeLodgeHold: false,
            wholeLodgeHoldAt: null,
            wholeLodgeHoldByMemberId: null,
            adminCapacityHoldAt: null,
            originBookingRequest: null,
          }
        : { lodgeId: "lodge-1" },
    );
    h.prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.bedAllocation.findMany.mockResolvedValue([]);
    h.reconcileGlobal.mockResolvedValue({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
      promotedCount: 0,
      plannedNights: 0,
    });
    const holding = {
      id: "booking-9",
      memberName: "Pat Other",
      checkIn: "2026-08-02",
      checkOut: "2026-08-04",
      guestCount: 4,
      status: "PAID",
      // Absent on a real holding conflict; set here so the strict check sees the field.
      overridden: false,
      lodgeId: "lodge-1",
    };
    const overridden = { ...holding, id: "booking-10", status: "PAYMENT_PENDING", overridden: true };
    h.holdingConflicts.mockResolvedValue([holding]);
    h.overriddenConflicts.mockResolvedValue([overridden]);

    const { connection, browser } = await expectActionContract({
      actionId: "set_exclusive_lodge_hold",
      handler: exclusiveHold,
      args: { id: "booking-1", hold: true },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.acquireLodgeCapacityLock).toHaveBeenCalledWith(h.prisma, "lodge-1");
    expect(h.prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ wholeLodgeHold: true, wholeLodgeHoldByMemberId: OFFICER }) }),
    );
    const projectedHolding = omit(holding, "lodgeId");
    const reconcile = { enabled: true, deletedCount: 2, createdCount: 0, promotedCount: 0 };
    expect(connection).toEqual({
      success: true,
      wholeLodgeHold: true,
      wholeLodgeHoldAt: "2026-07-01T00:00:00.000Z",
      conflicts: [projectedHolding, { ...projectedHolding, id: "booking-10", status: "PAYMENT_PENDING", overridden: true }],
      bedAllocationReconcile: reconcile,
    });
    expect(browser).toEqual({
      success: true,
      wholeLodgeHold: true,
      wholeLodgeHoldAt: "2026-07-01T00:00:00.000Z",
      conflicts: [holding, overridden],
      bedAllocationReconcile: reconcile,
    });
  });
});

describe("force_confirm_waitlisted_booking", () => {
  it("confirms over capacity when told to and answers the new status without the audit action", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-7",
      lodgeId: "lodge-1",
      status: "WAITLISTED",
      checkIn: day("2026-08-01"),
      checkOut: day("2026-08-02"),
      finalPriceCents: 24000,
      adminReviewStatus: "APPROVED",
      adminReviewReason: null,
      guests: [guestRow()],
      member: { id: "member-7", email: "alex@example.test", firstName: "Alex", lastName: "Smith" },
      organisation: null,
      promoRedemptions: [],
    });
    h.checkCapacity.mockResolvedValue(overbookedCapacity("2026-08-01"));
    h.postingContext.mockResolvedValue({});
    h.prisma.booking.update.mockResolvedValue({});
    h.reconcileGlobal.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0, promotedCount: 0 });
    h.enqueueHosting.mockResolvedValue(undefined);
    h.settleHosting.mockResolvedValue(undefined);

    const { connection, browser } = await expectActionContract({
      actionId: "force_confirm_waitlisted_booking",
      handler: forceConfirm,
      args: { id: "booking-1", allowOverbook: true },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAYMENT_PENDING", capacityOverriddenByMemberId: OFFICER }),
      }),
    );
    // Payment pending: no confirmation email goes out.
    expect(h.sendConfirmed).not.toHaveBeenCalled();
    const projected = {
      success: true,
      overbooked: true,
      overbookDates: ["2026-08-01"],
      status: "PAYMENT_PENDING",
      unpaidFinishedStay: false,
    };
    expect(connection).toEqual(projected);
    expect(browser).toEqual({ ...projected, auditAction: "waitlist.force_confirmed_overbook" });
  });
});

describe("send_fresh_booking_email_copy", () => {
  it("sends the copy and answers the template without the address it went to", async () => {
    h.sendFreshCopy.mockResolvedValue({
      ok: true,
      template: "booking-confirmed",
      sentTo: "alex@example.test",
      archivedFailureCount: 1,
      warning: null,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "send_fresh_booking_email_copy",
      handler: freshEmailCopy,
      args: { id: "booking-1", template: "booking-confirmed" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.sendFreshCopy).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", template: "booking-confirmed", actorMemberId: OFFICER }),
    );
    const projected = { success: true, template: "booking-confirmed", archivedFailureCount: 1, warning: null };
    expect(connection).toEqual(projected);
    expect(browser).toEqual({ ...projected, sentTo: "alex@example.test" });
  });
});

describe("set_booking_no_emails", () => {
  it("turns the switch on when acknowledged and answers it without who set it", async () => {
    h.setNoEmails.mockResolvedValue({
      ok: true,
      noEmails: true,
      noEmailsAt: new Date("2026-07-01T00:00:00.000Z"),
      noEmailsByMemberId: OFFICER,
      changed: true,
      hasLiveWaitlistOffer: true,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "set_booking_no_emails",
      handler: noEmails,
      args: { id: "booking-1", noEmails: true, acknowledged: true },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.setNoEmails).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", noEmails: true, acknowledged: true, actorMemberId: OFFICER }),
    );
    const projected = {
      success: true,
      noEmails: true,
      noEmailsAt: "2026-07-01T00:00:00.000Z",
      changed: true,
      hasLiveWaitlistOffer: true,
    };
    expect(connection).toEqual(projected);
    expect(browser).toEqual({ ...projected, noEmailsByMemberId: OFFICER });
  });
});

describe("set_booking_requested_room", () => {
  it("records the room as an officer and answers the booking and room", async () => {
    const updated = {
      id: "booking-1",
      requestedRoomId: "room-1",
      requestedRoom: { id: "room-1", name: "Kea", active: true, lodgeId: "lodge-1" },
    };
    h.writeRequestedRoom.mockResolvedValue(updated);

    const { connection, browser } = await expectActionContract({
      actionId: "set_booking_requested_room",
      handler: setRequestedRoom,
      args: { id: "booking-1", requestedRoomId: "room-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.writeRequestedRoom).toHaveBeenCalledWith({
      bookingId: "booking-1",
      actorMemberId: OFFICER,
      actorIsAdmin: true,
      requestedRoomId: "room-1",
      auditActorLabel: "Admin",
    });
    expect(connection).toEqual({
      id: "booking-1",
      requestedRoomId: "room-1",
      requestedRoom: { id: "room-1", name: "Kea", active: true },
    });
    expect(browser).toEqual(updated);
  });
});

describe("clear_booking_requested_room", () => {
  it("clears the room and answers the booking with no room", async () => {
    h.writeRequestedRoom.mockResolvedValue({ id: "booking-1", requestedRoomId: null, requestedRoom: null });

    const { connection, browser } = await expectActionContract({
      actionId: "clear_booking_requested_room",
      handler: clearRequestedRoom,
      args: { id: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.writeRequestedRoom).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", actorIsAdmin: true, requestedRoomId: null }),
    );
    expect(connection).toEqual({ id: "booking-1", requestedRoomId: null });
    expect(browser).toEqual({ id: "booking-1", requestedRoomId: null, requestedRoom: null });
  });
});

describe("return_booking_to_waitlist", () => {
  it("puts the stranded booking back in its place and answers the place shown", async () => {
    h.prisma.booking.findUnique.mockImplementation(async (args: FindUniqueArgs) =>
      args.select?.createdAt
        ? { lodgeId: "lodge-1", memberId: "member-7", createdAt: day("2026-05-01") }
        : {
            status: "PAYMENT_PENDING",
            finalPriceCents: 0,
            checkIn: day("2026-08-01"),
            checkOut: day("2026-08-03"),
            adminCapacityHoldAt: null,
            adminCapacityHoldByMemberId: null,
            wholeLodgeHold: false,
            wholeLodgeHoldAt: null,
            wholeLodgeHoldByMemberId: null,
            noEmails: false,
            member: { email: "alex@example.test", firstName: "Alex" },
            organisation: null,
            payment: null,
          },
    );
    h.strandReport.mockResolvedValue({ id: "audit-1", createdAt: day("2026-06-30") });
    h.prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    h.reconcileLodge.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0, promotedCount: 0 });
    h.waitlistPosition.mockResolvedValue(3);
    h.sendPlaceRestored.mockResolvedValue(undefined);
    h.processWaitlist.mockResolvedValue(undefined);

    const { connection, browser } = await expectActionContract({
      actionId: "return_booking_to_waitlist",
      handler: returnToWaitlist,
      args: { id: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(BOOKINGS_EDIT);
    expect(h.prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "WAITLISTED" }) }),
    );
    expect(h.sendPlaceRestored).toHaveBeenCalled();
    const answer = { success: true, status: "WAITLISTED", waitlistPosition: 3 };
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });
});
