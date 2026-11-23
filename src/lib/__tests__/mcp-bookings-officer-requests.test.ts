/**
 * ALP-719 (`INV-MCP-006`): the Bookings & Beds booking-request actions an
 * officer's AI app connection may run (`/api/admin/booking-requests/**`).
 * Each route answers the browser as before; the connection gets only the
 * action's `returns` fields. Every handler runs twice (connection, then
 * browser), so each service double answers both runs.
 *
 * Most actions go through `expectActionContract`. Four answers carry keys the
 * strict helper cannot see all at once: the request view's "cannot be read"
 * flags are sent only for a damaged row (whose lists are then empty), and an
 * approval answers one of three shapes by kind of request. Those run through
 * `runAsConnectionAndBrowser`, which builds the request from the catalogue
 * entry the same way (`buildActionRequest`) and checks the connection got exactly the projection
 * onto the action's shape, with the dropped fields named.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  currentHeaders: null as Headers | null,
  prisma: {
    bookingRequest: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    bookingRequestQuote: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    member: { findMany: vi.fn() },
    lodge: { count: vi.fn() },
  },
  flags: vi.fn(),
  memberChoosesPaymentMethod: vi.fn(),
  suggestedRates: vi.fn(),
  softCap: vi.fn(),
  wholeLodgeFlatPrices: vi.fn(),
  pendingCounts: vi.fn(),
  approveGeneral: vi.fn(),
  approveSchool: vi.fn(),
  approveMemberWholeLodge: vi.fn(),
  priceRequest: vi.fn(),
  createQuote: vi.fn(),
  sendQuote: vi.fn(),
  holdSlots: vi.fn(),
  linkConflicts: vi.fn(),
  clubToday: vi.fn(),
  lodgeCapacity: vi.fn(),
  checkCapacity: vi.fn(),
  heldNights: vi.fn(),
  holdingConflicts: vi.fn(),
  overriddenConflicts: vi.fn(),
  resolvePendingAdults: vi.fn(),
  resendAttendeeConfirmation: vi.fn(),
  previewSchoolRecord: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
// `servingMcpConnection` reads the request being served: the pending-counts
// handler takes no request, so the test hands it the one it is answering.
vi.mock("next/headers", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("next/headers")),
  headers: async () => h.currentHeaders ?? new Headers(),
}));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: h.flags,
}));
vi.mock("@/lib/booking-payment-flow", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-payment-flow")),
  memberWholeLodgeChoosesPaymentMethod: h.memberChoosesPaymentMethod,
}));
vi.mock("@/lib/booking-request-suggested-rates", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-request-suggested-rates")),
  resolveSuggestedGuestNightRatesForRequests: h.suggestedRates,
}));
vi.mock("@/lib/lodge-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-settings")),
  loadSchoolGroupSoftCap: h.softCap,
}));
vi.mock("@/lib/admin-booking-request-pending-counts", () => ({
  getBookingRequestPendingCounts: h.pendingCounts,
}));
vi.mock("@/lib/booking-request", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-request")),
  approveBookingRequest: h.approveGeneral,
  priceBookingRequest: h.priceRequest,
}));
vi.mock("@/lib/school-booking-request", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/school-booking-request")),
  approveSchoolBookingRequest: h.approveSchool,
  approveMemberWholeLodgeRequest: h.approveMemberWholeLodge,
  resolveWholeLodgeFlatPricesForRequests: h.wholeLodgeFlatPrices,
}));
vi.mock("@/lib/booking-request-quotes", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-request-quotes")),
  createBookingRequestQuote: h.createQuote,
  sendBookingRequestQuote: h.sendQuote,
  holdBookingRequestSlots: h.holdSlots,
  findLinkedGuestMemberNightConflicts: h.linkConflicts,
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTodayDateOnlyInstant: h.clubToday,
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getLodgeCapacity: h.lodgeCapacity,
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  checkCapacity: h.checkCapacity,
  getLodgeHeldNights: h.heldNights,
  findOverlappingCapacityHoldingBookings: h.holdingConflicts,
  findOverlappingOverriddenNonHoldingBookings: h.overriddenConflicts,
}));
vi.mock("@/lib/school-pending-adult-resolution", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/school-pending-adult-resolution")),
  resolveAcceptedSchoolPendingAdults: h.resolvePendingAdults,
}));
vi.mock("@/lib/school-attendee-confirmation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/school-attendee-confirmation")),
  resendSchoolAttendeeConfirmation: h.resendAttendeeConfirmation,
}));
vi.mock("@/lib/school-organisation-preview", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/school-organisation-preview")),
  previewSchoolRecordForName: h.previewSchoolRecord,
}));

import { GET as listRequests } from "@/app/api/admin/booking-requests/route";
import { GET as pendingCounts } from "@/app/api/admin/booking-requests/pending-counts/route";
import { POST as approve } from "@/app/api/admin/booking-requests/[id]/approve/route";
import { GET as contacts } from "@/app/api/admin/booking-requests/[id]/contacts/route";
import { GET as holdConflicts } from "@/app/api/admin/booking-requests/[id]/hold-conflicts/route";
import { POST as hold } from "@/app/api/admin/booking-requests/[id]/hold/route";
import { POST as linkConflicts } from "@/app/api/admin/booking-requests/[id]/link-conflicts/route";
import { POST as price } from "@/app/api/admin/booking-requests/[id]/price/route";
import { POST as saveQuote } from "@/app/api/admin/booking-requests/[id]/quote/route";
import { POST as resendAttendees } from "@/app/api/admin/booking-requests/[id]/resend-attendee-confirmation/route";
import { POST as resolvePendingAdults } from "@/app/api/admin/booking-requests/[id]/resolve-pending-adults/route";
import { GET as schoolRecord } from "@/app/api/admin/booking-requests/[id]/school-record/route";
import { POST as sendQuote } from "@/app/api/admin/booking-requests/[id]/send-quote/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { projectForConnection } from "@/lib/connection-projection";
import { findMcpAction, type McpAction } from "@/lib/mcp/catalogue";
import { BOOKINGS_REQUEST_MCP_ACTIONS } from "@/lib/mcp/catalogue/bookings-requests";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const OFFICER = "officer-1";

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

type Handler = (request: never, context: never) => Promise<Response>;

/**
 * Runs an action's route as a connection and as a browser, the request built
 * from the catalogue entry (`buildActionRequest`), and checks the connection got exactly the
 * projection of the browser's answer onto the action's `returns`.
 */
async function runAsConnectionAndBrowser(actionId: string, handler: Handler, args: Record<string, unknown>) {
  const action = findMcpAction(actionId) as McpAction;
  expect(action, `${actionId} is in the catalogue`).toBeDefined();
  const run = async (viaConnection: boolean) => {
    const { request, context } = buildActionRequest(action, args, viaConnection);
    const call = handler as unknown as (r: Request, c: unknown) => Promise<Response>;
    const response = await call(request, context);
    expect(response.status, `${actionId} succeeds`).toBeLessThan(300);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const connection = await run(true);
  const browser = await run(false);
  expect(connection).toEqual(projectForConnection(browser, action.returns));
  return { connection, browser };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const STORED_OPTION = {
  id: "opt-1",
  label: "Catered",
  cateringOption: "CATERED",
  totalCents: 12000,
  pricingMode: "PER_GUEST_NIGHT",
  guestNightRates: [{ ageTier: "ADULT", isMember: true, rateCents: 6000 }],
  guestBreakdown: [
    {
      guestIndex: 0,
      kind: "NAMED",
      firstName: "Tui",
      lastName: "Teacher",
      ageTier: "ADULT",
      isMember: true,
      memberId: "member-7",
      nightCount: 2,
      rateCents: 6000,
      totalCents: 12000,
    },
  ],
};

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    type: "SCHOOL",
    status: "PRICED",
    version: 4,
    lodgeId: "lodge-1",
    lodge: { name: "Ruapehu" },
    otherLodgeId: "other-1",
    otherLodge: { name: "Tararua", location: "Wellington" },
    exclusivityRequested: true,
    requestedByMemberId: null,
    applyAccountCredit: false,
    schoolName: "Hill School",
    teachers: [{ firstName: "Tui", lastName: "Teacher", email: "tui@hill.school.example" }],
    pendingAdultCount: 1,
    cateringPreference: "CATERED",
    linkedGuestMembers: [{ guestIndex: 0, memberId: "member-7" }],
    contactFirstName: "Tui",
    contactLastName: "Teacher",
    contactEmail: "office@hill.school.example",
    contactPhone: "021 555 0101",
    checkIn: day("2026-09-01"),
    checkOut: day("2026-09-03"),
    guests: [
      { firstName: "Tui", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child 1", lastName: "Hill", ageTier: "CHILD" },
    ],
    message: "Two nights for the senior class",
    indicativePriceCents: 30000,
    priceCents: 28000,
    verifiedAt: day("2026-06-20"),
    pricedAt: day("2026-06-21"),
    pricedByMemberId: "officer-2",
    reviewedAt: day("2026-06-22"),
    reviewedByMemberId: "officer-3",
    declineReason: null,
    convertedBookingId: "booking-converted",
    attendeesConfirmedAt: day("2026-06-23"),
    convertedMemberId: "member-school",
    heldBookingId: "booking-held",
    acceptedQuoteId: "quote-1",
    acceptedQuoteOptionId: "opt-1",
    acceptedPriceCents: 12000,
    acceptedAt: day("2026-06-24"),
    responseMessage: "Thanks",
    responseMessageAt: day("2026-06-25"),
    createdAt: day("2026-06-19"),
    updatedAt: day("2026-06-26"),
    organisationId: "org-1",
    verificationTokenHash: "not for an AI provider",
    ...overrides,
  };
}

/** The request view's fields a connection never gets. */
const VIEW_FIELDS_DROPPED = ["otherLodgeId", "pricedByMemberId", "reviewedByMemberId", "acceptedQuoteId"];

const HOLD_CONFLICTS = [
  {
    id: "booking-9",
    memberName: "Ana Reid",
    checkIn: "2026-09-01",
    checkOut: "2026-09-02",
    guestCount: 3,
    status: "PAID",
    overridden: false,
    lodgeId: "lodge-1",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.currentHeaders = null;
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession(OFFICER) });
});

describe("the booking-request actions", () => {
  it("are decided as the issue's kinds, with link checking the only side-effect-free POST", () => {
    const kinds = Object.fromEntries(
      BOOKINGS_REQUEST_MCP_ACTIONS.map((action) => [action.id, `${action.kind}${action.preview ? "+preview" : ""}`]),
    );
    expect(kinds).toEqual({
      list_booking_requests: "read",
      get_booking_request_counts: "read",
      list_booking_request_contacts: "read",
      get_booking_request_hold_conflicts: "read",
      check_booking_request_member_links: "read+preview",
      preview_booking_request_school_record: "read",
      price_booking_request: "destructive",
      save_booking_request_quote: "destructive",
      send_booking_request_quote: "destructive",
      hold_booking_request_beds: "destructive",
      approve_booking_request: "destructive",
      name_school_pending_adults: "destructive",
      resend_school_attendee_confirmation: "destructive",
    });
  });

  it("each resolve to the Bookings & Beds area: view for a GET, edit for a POST (the link check too)", () => {
    for (const action of BOOKINGS_REQUEST_MCP_ACTIONS) {
      const path = action.path.replace("[id]", "req-1");
      expect(getAdminRouteRequirement(path, action.method), action.id).toEqual({
        area: "bookings",
        level: action.method === "GET" ? "view" : "edit",
      });
    }
  });
});

describe("list_booking_requests", () => {
  function queueFixtures(row: ReturnType<typeof requestRow>, quoteOptions: unknown = [STORED_OPTION]) {
    h.prisma.bookingRequest.findMany.mockResolvedValue([row]);
    h.prisma.bookingRequest.count.mockResolvedValue(1);
    h.prisma.member.findMany.mockResolvedValue([
      { id: "officer-2", firstName: "Pat", lastName: "Pricer" },
      { id: "officer-3", firstName: "Rae", lastName: "Reviewer" },
    ]);
    h.prisma.bookingRequestQuote.findMany.mockResolvedValue([
      {
        id: "quote-1",
        bookingRequestId: "req-1",
        version: 2,
        status: "SENT",
        pricingMode: "PER_GUEST_NIGHT",
        sentAt: day("2026-06-24"),
        responseTokenExpiresAt: day("2026-07-08"),
        responseTokenHash: "not sent anywhere",
        options: quoteOptions,
      },
    ]);
    h.prisma.booking.findMany.mockResolvedValue([{ id: "booking-held", status: "AWAITING_REVIEW" }]);
    h.prisma.lodge.count.mockResolvedValue(2);
    h.softCap.mockResolvedValue(40);
    h.wholeLodgeFlatPrices.mockResolvedValue(new Map());
    h.suggestedRates.mockResolvedValue(new Map([["req-1", { ADULT: { nonMemberCents: 6000, memberCents: 4000 } }]]));
    h.flags.mockResolvedValue({});
    h.memberChoosesPaymentMethod.mockReturnValue(true);
  }

  it("answers the queue page with each request's officer view, its latest quote and the suggested rates", async () => {
    queueFixtures(requestRow());

    const { connection, browser } = await runAsConnectionAndBrowser("list_booking_requests", listRequests, {
      status: "ALL",
      page: 1,
    });

    // Bare `requireAdmin()`: a GET here infers bookings view (pinned above).
    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.prisma.bookingRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 0 }));
    expect(connection).toMatchObject({
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
      memberWholeLodgeChoosesPaymentMethod: true,
      data: [
        {
          id: "req-1",
          lodgeName: "Ruapehu",
          otherLodgeName: "Tararua (Wellington)",
          teachers: [{ firstName: "Tui", lastName: "Teacher", email: "tui@hill.school.example" }],
          linkedGuestMembers: [{ guestIndex: 0, memberId: "member-7" }],
          guests: [{ firstName: "Tui" }, { firstName: "School Child 1" }],
          pricedByMemberName: "Pat Pricer",
          reviewedByMemberName: "Rae Reviewer",
          heldBookingStatus: "AWAITING_REVIEW",
          schoolGroupSoftCap: 40,
          latestQuote: { version: 2, status: "SENT", options: [asJson(STORED_OPTION)] },
          suggestedGuestNightRates: { ADULT: { nonMemberCents: 6000, memberCents: 4000 } },
        },
      ],
    });
    const [row] = connection.data as Array<Record<string, unknown>>;
    const [browserRow] = browser.data as Array<Record<string, unknown>>;
    for (const field of VIEW_FIELDS_DROPPED) {
      expect(row, field).not.toHaveProperty(field);
      expect(browserRow, field).toHaveProperty(field);
    }
    expect(row!.latestQuote).not.toHaveProperty("id");
    expect(browserRow!.latestQuote).toHaveProperty("id", "quote-1");
    // A well-formed row carries no "cannot be read" flag, to either.
    expect(row).not.toHaveProperty("guestDataNeedsAttention");
  });

  it("passes on the flags of a request whose stored parts cannot be read", async () => {
    queueFixtures(
      requestRow({
        guests: [{ firstName: "Mr", lastName: "", ageTier: "ADULT" }],
        linkedGuestMembers: "not a list",
        teachers: "not a list",
      }),
      "not a list",
    );

    const { connection } = await runAsConnectionAndBrowser("list_booking_requests", listRequests, {});

    expect(connection.data).toEqual([
      expect.objectContaining({
        guests: [{ firstName: "Mr", lastName: "", ageTier: "ADULT" }],
        guestDataNeedsAttention: true,
        linkedMemberDataNeedsAttention: true,
        teacherDataNeedsAttention: true,
        quoteDataNeedsAttention: true,
      }),
    ]);
  });
});

describe("get_booking_request_counts", () => {
  it("answers the four queue counts", async () => {
    const counts = {
      bookingReviews: 2,
      lockedPeriodChangeRequests: 1,
      policyExceptionRequests: 0,
      publicBookingRequests: 3,
    };
    h.pendingCounts.mockResolvedValue({ ...counts, cachedAt: "not promised" });

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_request_counts",
      handler: ((request: Request) => {
        h.currentHeaders = request.headers;
        return pendingCounts();
      }) as unknown as Handler,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith({ permission: { area: "bookings", level: "view" } });
    expect(connection).toEqual(counts);
    expect(browser).toEqual({ ...counts, cachedAt: "not promised" });
  });
});

describe("list_booking_request_contacts", () => {
  it("answers the matching non-login contacts with their address, phone and booking count", async () => {
    h.prisma.bookingRequest.findUnique.mockResolvedValue({
      contactEmail: "office@hill.school.example",
      contactFirstName: "Tui",
      contactLastName: "Teacher",
      schoolName: "Hill School",
    });
    h.prisma.member.findMany.mockResolvedValue([
      {
        id: "contact-1",
        firstName: "Hill",
        lastName: "School",
        email: "office@hill.school.example",
        role: "SCHOOL",
        phoneNumber: "07 555 0100",
        _count: { bookings: 3 },
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_request_contacts",
      handler: contacts,
      args: { id: "req-1", q: "hill" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.prisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [expect.objectContaining({ canLogin: false, archivedAt: null }), expect.anything()] },
        take: 8,
      }),
    );
    const expected = {
      contacts: [
        {
          id: "contact-1",
          firstName: "Hill",
          lastName: "School",
          email: "office@hill.school.example",
          role: "SCHOOL",
          phoneNumber: "07 555 0100",
          bookingCount: 3,
        },
      ],
    };
    expect(connection).toEqual(expected);
    expect(browser).toEqual(expected);
  });
});

describe("get_booking_request_hold_conflicts", () => {
  it("answers each night's beds and the overlapping bookings", async () => {
    h.prisma.bookingRequest.findUnique.mockResolvedValue({
      id: "req-1",
      checkIn: day("2026-09-01"),
      checkOut: day("2026-09-02"),
      lodgeId: "lodge-1",
    });
    h.lodgeCapacity.mockResolvedValue(20);
    h.checkCapacity.mockResolvedValue({ nightDetails: [{ date: day("2026-09-01"), availableBeds: 17 }] });
    h.heldNights.mockResolvedValue(["2026-09-01"]);
    h.holdingConflicts.mockResolvedValue(HOLD_CONFLICTS);
    h.overriddenConflicts.mockResolvedValue([{ ...HOLD_CONFLICTS[0], id: "booking-10", overridden: true }]);

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_request_hold_conflicts",
      handler: holdConflicts,
      args: { id: "req-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    const nights = [{ date: "2026-09-01", availableBeds: 17, occupiedBeds: 3, wholeLodgeHeld: true }];
    const conflict = omit(HOLD_CONFLICTS[0]!, "lodgeId");
    expect(connection).toEqual({
      lodgeId: "lodge-1",
      lodgeCapacity: 20,
      nights,
      conflicts: [conflict, { ...conflict, id: "booking-10", overridden: true }],
    });
    expect(browser).toEqual({
      lodgeId: "lodge-1",
      lodgeCapacity: 20,
      nights,
      conflicts: [HOLD_CONFLICTS[0], { ...HOLD_CONFLICTS[0], id: "booking-10", overridden: true }],
    });
  });
});

describe("check_booking_request_member_links", () => {
  it("answers the clashes without the guest-row id or the booker-relative flags", async () => {
    const today = day("2026-07-01");
    h.clubToday.mockResolvedValue(today);
    const clash = {
      memberId: "member-7",
      memberName: "Tui Teacher",
      conflictingNights: ["2026-09-01"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: false,
      isSelfGuest: false,
      bookingId: "booking-9",
      bookingStatus: "PAID",
      bookingOwnerName: "Ana Reid",
      bookingCheckIn: "2026-09-01",
      bookingCheckOut: "2026-09-03",
      guestId: "guest-44",
    };
    h.linkConflicts.mockResolvedValue([clash]);

    const links = [{ guestIndex: 0, memberId: "member-7" }];
    const { connection, browser } = await expectActionContract({
      actionId: "check_booking_request_member_links",
      handler: linkConflicts,
      args: { id: "req-1", links },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.linkConflicts).toHaveBeenCalledWith({ requestId: "req-1", adminMemberId: OFFICER, links, today });
    const kept = omit(clash, "isOwnBooking", "canOpenBooking", "canSelfRemove", "isSelfGuest", "guestId");
    expect(connection).toEqual({ conflicts: [kept] });
    expect(browser).toEqual({ conflicts: [clash] });
  });
});

describe("preview_booking_request_school_record", () => {
  it("answers which school record the name joins, without the record's id", async () => {
    h.prisma.bookingRequest.findUnique.mockResolvedValue({ id: "req-1", type: "SCHOOL", schoolName: "Hill School" });
    const preview = {
      normalisedName: "Valley School",
      known: true,
      schoolRecordId: "org-1",
      schoolRecordName: "Valley School",
      schoolRecordArchived: false,
      schoolRecordHasXeroCustomer: true,
      currentContactNames: ["Rewi Teacher"],
      currentContactNamesTruncated: false,
    };
    h.previewSchoolRecord.mockResolvedValue(preview);

    const { connection, browser } = await expectActionContract({
      actionId: "preview_booking_request_school_record",
      handler: schoolRecord,
      args: { id: "req-1", name: "Valley School" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.previewSchoolRecord).toHaveBeenCalledWith(h.prisma, "Valley School");
    expect(connection).toEqual({ schoolRecord: omit(preview, "schoolRecordId") });
    expect(browser).toEqual({ schoolRecord: preview });
  });
});

describe("price_booking_request", () => {
  it("prices the request and answers its officer view", async () => {
    h.priceRequest.mockResolvedValue(requestRow({ priceCents: 25000 }));

    const { connection, browser } = await runAsConnectionAndBrowser("price_booking_request", price, {
      id: "req-1",
      priceCents: 25000,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.priceRequest).toHaveBeenCalledWith({ requestId: "req-1", adminMemberId: OFFICER, priceCents: 25000 });
    expect(connection).toMatchObject({
      id: "req-1",
      priceCents: 25000,
      teachers: [{ firstName: "Tui" }],
      linkedGuestMembers: [{ guestIndex: 0, memberId: "member-7" }],
      checkIn: "2026-09-01T00:00:00.000Z",
    });
    for (const field of VIEW_FIELDS_DROPPED) {
      expect(connection, field).not.toHaveProperty(field);
      expect(browser, field).toHaveProperty(field);
    }
    expect(browser).not.toHaveProperty("verificationTokenHash");
  });
});

describe("save_booking_request_quote", () => {
  it("saves the quote and answers it without the quote's id", async () => {
    h.createQuote.mockResolvedValue({
      id: "quote-2",
      version: 3,
      status: "DRAFT",
      pricingMode: "PER_GUEST_NIGHT",
      options: [STORED_OPTION],
      message: "See you there",
      responseTokenHash: null,
    });
    const body = {
      pricingMode: "PER_GUEST_NIGHT",
      options: [{ id: "opt-1", cateringOption: "CATERED", guestNightRates: [{ ageTier: "ADULT", isMember: true, rateCents: 6000 }] }],
      linkedGuestMembers: [{ guestIndex: 0, memberId: "member-7" }],
      childCounts: { CHILD: 1 },
    };

    const { connection, browser } = await expectActionContract({
      actionId: "save_booking_request_quote",
      handler: saveQuote,
      args: { id: "req-1", ...body },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.createQuote).toHaveBeenCalledWith({ requestId: "req-1", adminMemberId: OFFICER, quote: body });
    const answer = { version: 3, status: "DRAFT", pricingMode: "PER_GUEST_NIGHT", options: [STORED_OPTION] };
    expect(connection).toEqual(answer);
    expect(browser).toEqual({ id: "quote-2", ...answer });
  });
});

describe("send_booking_request_quote", () => {
  it("sends the quote and answers its expiry and delivery without the quote's id", async () => {
    h.sendQuote.mockResolvedValue({
      id: "quote-2",
      version: 3,
      status: "SENT",
      responseTokenExpiresAt: day("2026-07-15"),
      emailDelivered: true,
      options: [STORED_OPTION],
      responseTokenHash: "not sent anywhere",
    });

    const { connection, browser } = await expectActionContract({
      actionId: "send_booking_request_quote",
      handler: sendQuote,
      args: { id: "req-1", ownerContactMemberId: "contact-1", childCounts: { CHILD: 1 } },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.sendQuote).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: OFFICER,
      ownerContactMemberId: "contact-1",
      childCounts: { CHILD: 1 },
    });
    const answer = {
      success: true,
      version: 3,
      status: "SENT",
      expiresAt: "2026-07-15T00:00:00.000Z",
      emailDelivered: true,
      options: [STORED_OPTION],
    };
    expect(connection).toEqual(answer);
    expect(browser).toEqual({ ...answer, id: "quote-2" });
  });

  it("refuses a blank contact choice as the website always has", async () => {
    const response = await sendQuote(
      new NextRequest("https://club.example.test/api/admin/booking-requests/req-1/send-quote", {
        method: "POST",
        headers: { "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "contract-test-principal" },
        body: JSON.stringify({ ownerContactMemberId: "   " }),
      }) as never,
      { params: Promise.resolve({ id: "req-1" }) } as never,
    );
    expect(response.status).toBe(422);
    expect(h.sendQuote).not.toHaveBeenCalled();
  });
});

describe("hold_booking_request_beds", () => {
  it("holds the beds and answers the held booking", async () => {
    h.holdSlots.mockResolvedValue({ type: "held", bookingId: "booking-held", reused: false });

    const { connection, browser } = await expectActionContract({
      actionId: "hold_booking_request_beds",
      handler: hold,
      args: { id: "req-1", optionId: "opt-1", ownerContactMemberId: "contact-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.holdSlots).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: OFFICER,
      optionId: "opt-1",
      ownerContactMemberId: "contact-1",
    });
    const answer = { success: true, bookingId: "booking-held", reused: false };
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });
});

describe("approve_booking_request", () => {
  it("approves a member's whole-lodge request with the officer's pricing and answers the conflicts to resolve", async () => {
    h.prisma.bookingRequest.findUnique.mockResolvedValue({
      type: "GENERAL",
      requestedByMemberId: "member-5",
      exclusivityRequested: true,
    });
    h.approveMemberWholeLodge.mockResolvedValue({
      type: "approved",
      requestId: "req-1",
      bookingId: "booking-new",
      memberId: "member-5",
      priceCents: 180000,
      guestCount: 12,
      invoiceMode: "member",
      exclusiveHoldConflicts: HOLD_CONFLICTS,
    });

    const { connection, browser } = await runAsConnectionAndBrowser("approve_booking_request", approve, {
      id: "req-1",
      pricedHeadcount: 12,
      priceAsWholeLodge: true,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.approveMemberWholeLodge).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: OFFICER,
      override: { pricedHeadcount: 12, priceAsWholeLodge: true },
    });
    const conflict = omit(HOLD_CONFLICTS[0]!, "lodgeId");
    const answer = {
      success: true,
      type: "MEMBER_WHOLE_LODGE",
      bookingId: "booking-new",
      memberId: "member-5",
      priceCents: 180000,
      guestCount: 12,
      invoiceMode: "member",
    };
    expect(connection).toEqual({ ...answer, exclusiveHoldConflicts: [conflict] });
    expect(browser).toEqual({ ...answer, exclusiveHoldConflicts: HOLD_CONFLICTS });
  });

  it("approves a school request with adjusted numbers onto a chosen contact", async () => {
    h.prisma.bookingRequest.findUnique.mockResolvedValue({
      type: "SCHOOL",
      requestedByMemberId: null,
      exclusivityRequested: false,
    });
    const answer = {
      success: true,
      type: "SCHOOL",
      bookingId: "booking-new",
      memberId: null,
      priceCents: 90000,
      invoiceMode: "xero",
      teacherCount: 2,
      teacherHutLeaderAssignmentsCreated: true,
      alreadyConverted: false,
      exclusiveHoldConflicts: [],
    };
    h.approveSchool.mockResolvedValue({
      type: "approved",
      requestId: "req-1",
      bookingId: "booking-new",
      schoolMemberId: null,
      priceCents: 90000,
      invoiceMode: "xero",
      teacherCount: 2,
      teacherHutLeaderAssignmentsCreated: true,
      alreadyConverted: false,
      exclusiveHoldConflicts: [],
    });

    const { connection, browser } = await runAsConnectionAndBrowser("approve_booking_request", approve, {
      id: "req-1",
      childCounts: { CHILD: 20, YOUTH: 4 },
      ownerContactMemberId: "contact-1",
    });

    expect(h.approveSchool).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: OFFICER,
      guestOverride: { childCounts: { CHILD: 20, YOUTH: 4 } },
      ownerContactMemberId: "contact-1",
    });
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });

  it("approves a public request and answers when its payment link expires", async () => {
    h.prisma.bookingRequest.findUnique.mockResolvedValue({
      type: "GENERAL",
      requestedByMemberId: null,
      exclusivityRequested: false,
    });
    h.approveGeneral.mockResolvedValue({
      type: "approved",
      bookingId: "booking-new",
      memberId: "member-new",
      priceCents: 28000,
      paymentLinkExpiresAt: day("2026-07-08"),
      paymentToken: "not for an AI provider",
    });

    const { connection, browser } = await runAsConnectionAndBrowser("approve_booking_request", approve, { id: "req-1" });

    expect(h.approveGeneral).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: OFFICER,
      ownerContactMemberId: undefined,
    });
    const answer = {
      success: true,
      type: "GENERAL",
      bookingId: "booking-new",
      memberId: "member-new",
      priceCents: 28000,
      paymentLinkExpiresAt: "2026-07-08T00:00:00.000Z",
    };
    expect(connection).toEqual(answer);
    expect(browser).toEqual(answer);
  });
});

describe("name_school_pending_adults", () => {
  it("names the adults and answers the request, its pending count and version", async () => {
    h.resolvePendingAdults.mockResolvedValue({ pendingAdultCount: 0, version: 5 });
    h.prisma.bookingRequest.findUnique.mockResolvedValue(requestRow({ status: "ACCEPTED", pendingAdultCount: 0, version: 5 }));
    const teachers = [{ firstName: "Rangi", lastName: "Parent", email: "rangi@example.test" }];

    const { connection, browser } = await runAsConnectionAndBrowser("name_school_pending_adults", resolvePendingAdults, {
      id: "req-1",
      expectedVersion: 4,
      teachers,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.resolvePendingAdults).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: OFFICER,
      expectedVersion: 4,
      teachers,
    });
    expect(connection).toMatchObject({
      pendingAdultCount: 0,
      version: 5,
      request: { id: "req-1", status: "ACCEPTED", teachers: [{ firstName: "Tui" }] },
    });
    for (const field of VIEW_FIELDS_DROPPED) {
      expect(connection.request, field).not.toHaveProperty(field);
      expect(browser.request, field).toHaveProperty(field);
    }
  });
});

describe("resend_school_attendee_confirmation", () => {
  it("sends the email and answers success without the address it went to", async () => {
    h.resendAttendeeConfirmation.mockResolvedValue({ sentTo: "office@hill.school.example" });

    const { connection, browser } = await expectActionContract({
      actionId: "resend_school_attendee_confirmation",
      handler: resendAttendees,
      args: { id: "req-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.resendAttendeeConfirmation).toHaveBeenCalledWith({ bookingRequestId: "req-1", adminMemberId: OFFICER });
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true, sentTo: "office@hill.school.example" });
  });
});
