/**
 * #4202: THE PROMO BOX AND THE QUOTE GIVE ONE DISCOUNT FOR ONE EDIT.
 *
 * The booking editor shows a code's discount twice: in the promo box
 * (`POST /api/promo-codes/validate`) and on the quote
 * (`POST /api/bookings/[id]/modify-quote`), which is what the save is held to
 * (INV-MOD-028). The quote prices the edit with each held night's sold price
 * (#1036, `INV-MOD-005`); the box used to price every night at today's rate,
 * so once the club's rates had moved since the booking was made the two
 * discounts differed.
 *
 * Each case below sends the SAME edit to both routes and compares the box's
 * answer with the quote's — one assertion over the pair, never an absolute
 * figure both sides could drift to together. Real pricing
 * (`priceBookingGuestsWithMembershipTypePolicy`), the real lock reader
 * (`editedGuestPricingLocks`) and the real promotion engine run on both sides;
 * only the database and the quote's unrelated collaborators (capacity, change
 * fee, Xero, settlement) are stubbed. A control case confirms the scenario
 * discriminates: today's rate on every night gives a different total.
 *
 * Frozen clock discipline: the booking is in late August 2026, after the
 * 2026-07-01 freeze; this file installs no clock of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  authorizationRole: vi.fn(),
  isMemberWholeLodgeBooking: vi.fn(),
  loadMemberGuestAddPolicy: vi.fn(),
  computeMemberGuestBoundary: vi.fn(),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  prisma: {
    otherLodge: { findFirst: vi.fn() },
    manualRefundTask: { findFirst: vi.fn(), findMany: vi.fn() },
    booking: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    bookingRequest: { findFirst: vi.fn() },
    promoCode: { findUnique: vi.fn(), findMany: vi.fn() },
    workPartyEvent: { findUnique: vi.fn() },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    promoRedemptionAllocation: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    member: { findMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn() },
    membershipType: { findMany: vi.fn() },
    clubTimeSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/admin-permissions", () => ({ bookingManagementAuthorizationRole: h.authorizationRole }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn(async () => "lodge-1"),
  lodgeNullTolerantScope: () => ({}),
  // The lodge a request names, as the real resolver answers for an active one.
  resolveOptionalActiveLodgeId: vi.fn(async (_db: unknown, lodgeId?: string) => lodgeId ?? "lodge-1"),
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getLodgeCapacity: vi.fn(async () => 29),
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  checkCapacityForGuestRanges: vi.fn(async () => ({ available: true, minAvailable: 5, nightDetails: [] })),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: vi.fn(async () => []),
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({ conflicts }),
}));
// The lock reader, the beneficiary resolver and the rest stay REAL; only the
// helpers that read the database for questions this file does not ask are
// stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-modify")),
  isQuotePricedBooking: vi.fn(async () => false),
  isMemberWholeLodgeBooking: h.isMemberWholeLodgeBooking,
  calculateModificationSettlementOptions: vi.fn(async () => null),
}));
vi.mock("@/lib/booking-guests", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-guests")),
  computeMemberGuestBoundary: h.computeMemberGuestBoundary,
  resolveLinkedBookingMembersWithBoundary: h.resolveLinkedBookingMembersWithBoundary,
  assertLinkedBookingMembersCanBeBooked: vi.fn(async () => undefined),
}));
vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-add-policy")),
  loadMemberGuestAddPolicy: h.loadMemberGuestAddPolicy,
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({ findUnpaidMemberGuestNames: vi.fn(async () => []) }));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn(async () => []),
  daysUntilDate: vi.fn(() => 30),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: vi.fn(() => ({ feeCents: 0 })) }));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: vi.fn(async () => ({ xeroIntegration: false })),
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn(async () => false) }));
vi.mock("@/lib/xero-organisation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-organisation")),
  getXeroLockDates: vi.fn(async () => ({ periodLockDate: null, endOfYearLockDate: null })),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn(async () => ({ valid: true, violations: [] })),
  formatViolationsDetail: () => "minimum stay",
  formatViolationMessage: () => "minimum stay",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn(async () => 0),
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit");
    return memberId;
  },
}));
vi.mock("@/lib/additional-ask-reduction", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/additional-ask-reduction")),
  readReductionAgainstUnpaidAsk: vi.fn(async () => ({ offsetCents: 0, askLeftCents: 0 })),
}));
vi.mock("@/lib/booking-modify-credit-give-back", () => ({
  previewPaidReductionCreditGiveBackCents: vi.fn(async () => 0),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as modifyQuote } from "@/app/api/bookings/[id]/modify-quote/route";
import { POST as validatePromo } from "@/app/api/promo-codes/validate/route";
import { GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE } from "@/lib/booking-modify";
import { OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE, OtherLodgeRateInProgressError } from "@/lib/booking-other-lodge-rate";

const D = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** Today's rate for a night. */
const NOW_RATE = 5000;
/** What each night already on the booking was sold at, before the rates went up. */
const SOLD = 4000;
const HELD = ["2026-08-24", "2026-08-25", "2026-08-26"];

function promo(overrides: Record<string, unknown>) {
  return {
    id: "promo-1",
    code: "SAVE",
    description: null,
    type: "PERCENTAGE",
    active: true,
    archivedAt: null,
    internal: false,
    percentOff: null,
    valueCents: null,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    membersOnly: false,
    validFrom: null,
    validUntil: null,
    bookingStartFrom: null,
    bookingStartUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    assignedMembersOnlyOwnNights: true,
    assignments: [],
    lodges: [],
    ...overrides,
  };
}

/** The stored guest: an adult member on 24-27 August, every night sold at the old rate. */
const storedGuest = {
  id: "g1",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m1",
  firstName: "Aroha",
  lastName: "Member",
  consentStatus: null,
  otherLodgeMember: false,
  stayStart: D("2026-08-24"),
  stayEnd: D("2026-08-27"),
  priceCents: 3 * SOLD,
  nights: HELD.map((night) => ({ stayDate: D(night), priceCents: SOLD, priceSource: "SOLD" })),
};

function storedBooking() {
  return {
    id: "b1",
    status: "DRAFT",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-08-24"),
    checkOut: D("2026-08-27"),
    totalPriceCents: 3 * SOLD,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 3 * SOLD,
    payment: null,
    promoRedemption: null,
    promoRedemptions: [],
    guests: [storedGuest],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  h.authorizationRole.mockReturnValue("USER");
  h.isMemberWholeLodgeBooking.mockResolvedValue(false);
  h.loadMemberGuestAddPolicy.mockResolvedValue({ wideningEnabled: false, approvalRequired: true, pendingHoldExpiryDays: 0 });
  h.computeMemberGuestBoundary.mockResolvedValue({ scopeByMemberId: new Map(), beyondFamilyMemberIds: [] });
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  });
  h.prisma.otherLodge.findFirst.mockResolvedValue({ id: "ol-1" });
  h.prisma.manualRefundTask.findFirst.mockResolvedValue(null);
  h.prisma.manualRefundTask.findMany.mockResolvedValue([]);
  h.prisma.booking.findUnique.mockResolvedValue(storedBooking());
  h.prisma.bookingGuest.findMany.mockResolvedValue([storedGuest]);
  h.prisma.bookingRequest.findFirst.mockResolvedValue(null);
  h.prisma.season.findMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-10-31"),
      type: "WINTER",
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
      ],
    },
  ]);
  h.prisma.groupDiscountSetting.findUnique.mockResolvedValue(null);
  h.prisma.promoRedemptionAllocation.aggregate.mockResolvedValue({ _sum: { freeNightsUsed: 0 } });
  h.prisma.promoRedemptionAllocation.count.mockResolvedValue(0);
  h.prisma.promoRedemptionAllocation.findMany.mockResolvedValue([]);
  h.prisma.member.findMany.mockResolvedValue([]);
  h.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
  h.prisma.membershipType.findMany.mockResolvedValue([
    { id: "type-nonmember", key: "NON_MEMBER" },
    { id: "type-full", key: "FULL" },
  ]);
  h.prisma.clubTimeSettings.findUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
    updatedByMemberId: null,
    updatedAt: D("2026-01-01"),
  });
});

/**
 * An edit: the new check-out, the code, and whether a non-member friend joins
 * for the whole stay. `setup` arranges the case's world before either route
 * runs; `boxBody` and `boxGuest` are what the editor's box sends beyond the
 * common request.
 */
type Edit = {
  /** The edit's check-in; the stored one (24 August) unless a case says otherwise. */
  checkIn?: string;
  checkOut: string;
  promo: Record<string, unknown>;
  addFriend?: boolean;
  setup?: () => void;
  boxBody?: Record<string, unknown>;
  boxGuest?: Record<string, unknown>;
  quoteBody?: Record<string, unknown>;
  /** Further guests the edit adds: as the quote is sent them, and as the box is. */
  quoteAdd?: Array<Record<string, unknown>>;
  boxAdd?: Array<Record<string, unknown>>;
  /**
   * The quote is sent the edit WITHOUT the code: for a refusal of the edit's
   * re-rate that the quote raises only once it is past its own refusal of a
   * code change (a stay under way refuses that first).
   */
  quoteWithoutCode?: boolean;
  /** Both routes refuse the code (the case compares the refusals); otherwise both must apply it. */
  refused?: boolean;
};

/** What a route answers about the code: the money when it applies, the words when it does not. */
type Answer =
  | { valid: true; totalPriceCents: number; discountCents: number; promoAdjustmentCents: number }
  | { valid: false; error: string };

/** The HTTP status each route last answered with, for the cases that compare them. */
const lastStatus = { quote: 0, box: 0 };

/** The quote's answer for the edit: its total and the promo line's discount. */
async function quote(edit: Edit) {
  h.prisma.promoCode.findUnique.mockResolvedValue(promo(edit.promo));
  const res = await modifyQuote(
    new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        checkIn: edit.checkIn ?? "2026-08-24",
        checkOut: edit.checkOut,
        ...(edit.quoteWithoutCode ? {} : { promoCode: "SAVE" }),
        ...edit.quoteBody,
        ...(edit.addFriend || edit.quoteAdd
          ? {
              addGuests: [
                ...(edit.addFriend ? [{ firstName: "Kiri", lastName: "Friend", ageTier: "ADULT", isMember: false }] : []),
                ...(edit.quoteAdd ?? []),
              ],
            }
          : {}),
      }),
    }),
    { params: Promise.resolve({ id: "b1" }) },
  );
  const body = await res.json();
  lastStatus.quote = res.status;
  if (res.status !== 200) return { valid: false, error: body.error as string } as Answer;
  expect(body.promoValidation, JSON.stringify(body)).toBeTruthy();
  if (!body.promoValidation.valid) return { valid: false, error: body.promoValidation.error as string } as Answer;
  return {
    valid: true,
    totalPriceCents: body.newTotalPriceCents as number,
    discountCents: body.promoValidation.discountCents as number,
    promoAdjustmentCents: body.newPromoAdjustmentCents as number,
  } as Answer;
}

/** The quote's money, for a case that must apply. */
async function quoted(edit: Edit) {
  const answer = await quote(edit);
  if (!answer.valid) throw new Error(`the quote refused: ${answer.error}`);
  return answer;
}

/** The promo box's answer for the same edit, as the booking editor sends it. */
async function box(edit: Edit) {
  h.prisma.promoCode.findUnique.mockResolvedValue(promo(edit.promo));
  h.prisma.promoCode.findMany.mockResolvedValue([promo(edit.promo)]);
  const res = await validatePromo(
    new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "SAVE",
        checkIn: edit.checkIn ?? "2026-08-24",
        checkOut: edit.checkOut,
        forBookingEdit: true,
        bookingId: "b1",
        lodgeId: "lodge-1",
        ...edit.boxBody,
        guests: [
          {
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            bookingGuestId: "g1",
            stayStart: edit.checkIn ?? "2026-08-24",
            stayEnd: edit.checkOut,
            ...edit.boxGuest,
          },
          ...(edit.addFriend ? [{ ageTier: "ADULT", isMember: false }] : []),
          ...(edit.boxAdd ?? []),
        ],
      }),
    }),
  );
  const body = await res.json();
  lastStatus.box = res.status;
  if (res.status !== 200 || !body.valid) return { valid: false, error: body.error as string } as Answer;
  return {
    valid: true,
    totalPriceCents: body.totalPriceCents as number,
    discountCents: body.discountCents as number,
    promoAdjustmentCents: body.promoAdjustmentCents as number,
  } as Answer;
}

/** Both routes, one assertion over the pair, and never a pair that agrees by both refusing unexpectedly. */
async function expectParity(edit: Edit) {
  edit.setup?.();
  const fromQuote = await quote(edit);
  const fromBox = await box(edit);
  expect(fromBox).toEqual(fromQuote);
  expect(fromQuote.valid, JSON.stringify(fromQuote)).toBe(!edit.refused);
}

const EDITS: Array<[string, Edit]> = [
  ["a percentage code on a one-night extension", { checkOut: "2026-08-28", promo: { percentOff: 50 } }],
  ["a percentage code on an unmoved stay", { checkOut: "2026-08-27", promo: { percentOff: 30 } }],
  [
    "a free-nights code covering every night",
    { checkOut: "2026-08-28", promo: { type: "FREE_NIGHTS", freeNightsPerIndividual: 4 } },
  ],
  [
    "a free-nights code covering some nights",
    { checkOut: "2026-08-29", promo: { type: "FREE_NIGHTS", freeNightsPerIndividual: 2 } },
  ],
  [
    "a percentage code with a guest added",
    { checkOut: "2026-08-28", promo: { percentOff: 50 }, addFriend: true },
  ],
  [
    "a fixed nightly price",
    { checkOut: "2026-08-28", promo: { type: "FIXED_NIGHTLY_PRICE", fixedNightlyPriceCents: 1000 } },
  ],
];

describe("#4202 the promo box and the quote give one discount after the rates moved", () => {
  for (const [name, edit] of EDITS) {
    it(`agrees on the total and the discount: ${name}`, async () => {
      await expectParity(edit);
    });
  }

  it("the comparison has teeth: the quote does not price the held nights at today's rate", async () => {
    const fromQuote = await quoted(EDITS[0]![1]);
    expect(fromQuote.totalPriceCents).toBe(3 * SOLD + NOW_RATE);
    expect(fromQuote.totalPriceCents).not.toBe(4 * NOW_RATE);
  });

  it("the added-guest case really prices the friend, at today's rate on every night", async () => {
    const [, edit] = EDITS.find(([, candidate]) => candidate.addFriend)!;
    expect((await quoted(edit)).totalPriceCents).toBe(3 * SOLD + NOW_RATE + 4 * NOW_RATE);
  });
});

/** An officer editing the member's booking: the caller is not the booking's owner. */
function officerCalling() {
  h.auth.mockResolvedValue({ user: { id: "officer-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  h.authorizationRole.mockReturnValue("ADMIN");
}

/**
 * #4202 (follow-on): beyond the prices, the box answers for the BOOKING the
 * quote prices — its own promotion slots left out of the usage caps, its stored
 * other-lodge flags, its owner and its lodge — not for whoever is asking or
 * whatever the request names.
 */
const BOOKING_EDITS: Array<[string, Edit]> = [
  [
    "a total-uses cap whose last slot is this booking's own",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, maxRedemptionsTotal: 1, currentRedemptions: 1 },
      setup: () =>
        h.prisma.promoRedemptionAllocation.count.mockImplementation(
          async ({ where }: { where?: { bookingId?: string } }) => (where?.bookingId === "b1" ? 1 : 0),
        ),
    },
  ],
  [
    "the same cap, through the box's several-code request",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, maxRedemptionsTotal: 1, currentRedemptions: 1 },
      boxBody: { code: undefined, codes: [{ code: "SAVE" }] },
      setup: () =>
        h.prisma.promoRedemptionAllocation.count.mockImplementation(
          async ({ where }: { where?: { bookingId?: string } }) => (where?.bookingId === "b1" ? 1 : 0),
        ),
    },
  ],
  [
    "a guest recognised as another club's member keeps that rate on the nights the edit buys",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: { isMember: false, memberId: undefined },
      setup: () => {
        const visitor = { ...storedGuest, isMember: false, memberId: null, otherLodgeMember: true };
        h.prisma.booking.findUnique.mockResolvedValue({ ...storedBooking(), guests: [visitor] });
        h.prisma.bookingGuest.findMany.mockResolvedValue([visitor]);
        h.prisma.season.findMany.mockResolvedValue([
          {
            id: "season-1",
            startDate: D("2026-06-01"),
            endDate: D("2026-10-31"),
            type: "WINTER",
            membershipTypeRates: [
              { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
              { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 2 * NOW_RATE },
            ],
          },
        ]);
      },
    },
  ],
  [
    "an officer editing a member's booking, with a code only that member may book with",
    {
      checkOut: "2026-08-28",
      // "Booker picks guests": the booker must be the assigned member, so the
      // answer depends on whose booking it is judged to be.
      promo: { percentOff: 50, assignments: [{ memberId: "m1" }], assignedMembersOnlyOwnNights: false },
      boxBody: { promoGuestIndexes: [0] },
      quoteBody: { promoGuestIds: ["g1"] },
      setup: officerCalling,
    },
  ],
  [
    "a request naming another lodge than the booking's, with a code for the booking's lodge",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, lodges: [{ lodgeId: "lodge-1" }] },
      boxBody: { lodgeId: "lodge-2" },
    },
  ],
];

describe("#4202 the box answers for the booking the quote prices", () => {
  for (const [name, edit] of BOOKING_EDITS) {
    it(`agrees on the total and the discount: ${name}`, async () => {
      await expectParity(edit);
    });
  }

  it("the other-lodge case has teeth: the bought night is at the member rate, not the non-member one", async () => {
    const [, edit] = BOOKING_EDITS[2]!;
    edit.setup?.();
    expect((await quoted(edit)).totalPriceCents).toBe(3 * SOLD + NOW_RATE);
  });
});

/** The booking's rows, with the one stored guest replaced, for both routes' reads. */
function storedWith(guest: Record<string, unknown>, booking: Record<string, unknown> = {}) {
  const row = { ...storedGuest, ...guest };
  h.prisma.booking.findUnique.mockResolvedValue({ ...storedBooking(), ...booking, guests: [row] });
  h.prisma.bookingGuest.findMany.mockResolvedValue([row]);
}

/** Member and non-member rates that differ, so a re-rate moves the price. */
function memberAndNonMemberRates() {
  h.prisma.season.findMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-10-31"),
      type: "WINTER",
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 2 * NOW_RATE },
      ],
    },
  ]);
}

/** A placeholder guest: no member, priced (and sold) at the non-member rate. */
const PLACEHOLDER = { isMember: false, memberId: null, firstName: "Guest", lastName: "3" };
const PLACEHOLDER_IN_BOX = { isMember: false, memberId: undefined };

/**
 * #4202 review: whose booking it is, and the officer re-rates the quote clears
 * locks for. Each case is the same edit to both routes; `refused` cases compare
 * the two refusals word for word.
 */
const REVIEW_EDITS: Array<[string, Edit]> = [
  [
    "a school's booking: an unassigned code is refused, as the quote refuses it",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      refused: true,
      setup: () => {
        officerCalling();
        storedWith(PLACEHOLDER, { memberId: null });
      },
      boxGuest: PLACEHOLDER_IN_BOX,
    },
  ],
  [
    "an officer naming another member than the owner: the owner wins",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, assignments: [{ memberId: "m1" }], assignedMembersOnlyOwnNights: false },
      boxBody: { promoGuestIndexes: [0], forMemberId: "m2" },
      quoteBody: { promoGuestIds: ["g1"] },
      setup: officerCalling,
    },
  ],
  [
    "an officer adds another family's member: confirmed as an officer's add, so their code covers them",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, assignments: [{ memberId: "m3" }], assignedMembersOnlyOwnNights: true },
      quoteAdd: [{ memberId: "m3", firstName: "Tane", lastName: "Other", ageTier: "ADULT", isMember: true }],
      boxAdd: [{ ageTier: "ADULT", isMember: true, memberId: "m3", stayStart: "2026-08-24", stayEnd: "2026-08-28" }],
      setup: () => {
        officerCalling();
        const beyond = { scopeByMemberId: new Map([["m3", "BEYOND_FAMILY"]]), beyondFamilyMemberIds: ["m3"] };
        h.loadMemberGuestAddPolicy.mockResolvedValue({
          wideningEnabled: true,
          approvalRequired: true,
          pendingHoldExpiryDays: 7,
          timeZone: "Pacific/Auckland",
        });
        h.computeMemberGuestBoundary.mockResolvedValue(beyond);
        h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
          members: new Map([
            ["m3", { id: "m3", ageTier: "ADULT", active: true, canLogin: true, firstName: "Tane", lastName: "Other" }],
          ]),
          boundary: beyond,
        });
      },
    },
  ],
  [
    "an officer ticks a placeholder as another club's member: every night re-rates to the member rate",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: PLACEHOLDER_IN_BOX,
      quoteBody: { otherLodgeId: "ol-1", otherLodgeMemberGuestIds: ["g1"] },
      boxBody: { otherLodgeId: "ol-1", otherLodgeMemberGuestIds: ["g1"] },
      setup: () => {
        officerCalling();
        memberAndNonMemberRates();
        storedWith(PLACEHOLDER);
      },
    },
  ],
  [
    "an officer unticks one: every night re-rates to the non-member rate",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: PLACEHOLDER_IN_BOX,
      quoteBody: { otherLodgeId: "ol-1", otherLodgeMemberGuestIds: [] },
      boxBody: { otherLodgeId: "ol-1", otherLodgeMemberGuestIds: [] },
      setup: () => {
        officerCalling();
        memberAndNonMemberRates();
        storedWith({ ...PLACEHOLDER, otherLodgeMember: true }, { otherLodgeId: "ol-1" });
      },
    },
  ],
  [
    "an officer links a placeholder to a member (#2337): every night re-rates to the member rate",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: PLACEHOLDER_IN_BOX,
      quoteBody: { linkGuestToMember: [{ guestId: "g1", memberId: "m9" }] },
      boxBody: { linkGuestToMember: [{ guestId: "g1", memberId: "m9" }] },
      setup: () => {
        officerCalling();
        memberAndNonMemberRates();
        h.isMemberWholeLodgeBooking.mockResolvedValue(true);
        storedWith(PLACEHOLDER, { wholeLodgeHold: true });
      },
    },
  ],
];

describe("#4202 review: the box judges the booking's owner and clears the locks the quote clears", () => {
  for (const [name, edit] of REVIEW_EDITS) {
    it(`agrees: ${name}`, async () => {
      await expectParity(edit);
    });
  }

  it("the re-rate cases have teeth: a ticked guest's held nights leave their sold price", async () => {
    const [, tick] = REVIEW_EDITS[3]!;
    tick.setup?.();
    expect((await quoted(tick)).totalPriceCents).toBe(4 * NOW_RATE);
    const [, untick] = REVIEW_EDITS[4]!;
    untick.setup?.();
    expect((await quoted(untick)).totalPriceCents).toBe(4 * 2 * NOW_RATE);
    const [, link] = REVIEW_EDITS[5]!;
    link.setup?.();
    expect((await quoted(link)).totalPriceCents).toBe(4 * NOW_RATE);
  });
});

/**
 * #4202 review r3: a member who is not an officer may not re-rate anybody, on
 * the quote or in the box, and both say so with the same 403 and the same words.
 * And an officer is judged as an officer even on their OWN booking, as the
 * quote's `isAdmin` judges them.
 */
describe("#4202 review r3: who may re-rate, and an officer's own booking", () => {
  const memberRerates: Array<[string, Record<string, unknown>, string]> = [
    ["a link", { linkGuestToMember: [{ guestId: "g1", memberId: "m9" }] }, GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE],
    ["an election", { otherLodgeId: "ol-1", otherLodgeMemberGuestIds: ["g1"] }, OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE],
  ];
  for (const [name, fields, message] of memberRerates) {
    it(`refuses the owner's own ${name} with the quote's 403`, async () => {
      const edit: Edit = {
        checkOut: "2026-08-28",
        promo: { percentOff: 50 },
        boxGuest: PLACEHOLDER_IN_BOX,
        quoteBody: fields,
        boxBody: fields,
        refused: true,
        setup: () => {
          // A member whole-lodge booking, so the link reaches the role check.
          h.isMemberWholeLodgeBooking.mockResolvedValue(true);
          storedWith(PLACEHOLDER, { wholeLodgeHold: true });
        },
      };
      await expectParity(edit);
      expect(await quote(edit)).toEqual({ valid: false, error: message });
      expect(lastStatus).toEqual({ quote: 403, box: 403 });
    });
  }

  it("an officer's link on a booking that is not a member's whole-lodge booking: the quote's member-origin fence", async () => {
    const fields = { linkGuestToMember: [{ guestId: "g1", memberId: "m9" }] };
    await expectParity({
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: PLACEHOLDER_IN_BOX,
      quoteBody: fields,
      boxBody: fields,
      refused: true,
      setup: () => {
        officerCalling();
        storedWith(PLACEHOLDER, { wholeLodgeHold: true });
      },
    });
    expect(lastStatus).toEqual({ quote: 400, box: 400 });
  });

  it("a link beside a rename of the same guest: the quote's refusal, judged on the same renames", async () => {
    const fields = {
      linkGuestToMember: [{ guestId: "g1", memberId: "m9" }],
      guestUpdates: [{ guestId: "g1", firstName: "Hemi", lastName: "Renamed" }],
    };
    await expectParity({
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: PLACEHOLDER_IN_BOX,
      quoteBody: fields,
      boxBody: fields,
      refused: true,
      setup: () => {
        officerCalling();
        h.isMemberWholeLodgeBooking.mockResolvedValue(true);
        storedWith(PLACEHOLDER, { wholeLodgeHold: true });
      },
    });
    expect(await quote({ checkOut: "2026-08-28", promo: { percentOff: 50 }, quoteBody: fields })).toEqual({
      valid: false,
      error: "A guest cannot be renamed and linked in the same change",
    });
  });

  it("a stay already under way: the quote's mid-stay refusal of an election, in the box too", async () => {
    // The panel hides the box on a stay under way, and the quote refuses any
    // code change there first; what the box mirrors is the re-rate's refusal.
    const fields = { otherLodgeId: "ol-1", otherLodgeMemberGuestIds: ["g1"] };
    await expectParity({
      quoteWithoutCode: true,
      checkIn: "2026-06-30",
      checkOut: "2026-07-03",
      promo: { percentOff: 50 },
      boxGuest: PLACEHOLDER_IN_BOX,
      quoteBody: fields,
      boxBody: fields,
      refused: true,
      setup: () => {
        officerCalling();
        storedWith(
          { ...PLACEHOLDER, stayStart: D("2026-06-30"), stayEnd: D("2026-07-03"), nights: [] },
          { status: "PAID", checkIn: D("2026-06-30"), checkOut: D("2026-07-03") },
        );
      },
    });
    expect(
      await quote({ checkIn: "2026-06-30", checkOut: "2026-07-03", promo: {}, quoteBody: fields, quoteWithoutCode: true }),
    ).toEqual({
      valid: false,
      error: new OtherLodgeRateInProgressError().message,
    });
  });

  it("an officer adding another family's member to their OWN booking is still an officer's add", async () => {
    const [, officerAdd] = REVIEW_EDITS.find(([name]) => name.startsWith("an officer adds another family's member"))!;
    await expectParity({
      ...officerAdd,
      setup: () => {
        officerAdd.setup?.();
        h.prisma.booking.findUnique.mockResolvedValue({ ...storedBooking(), memberId: "officer-1" });
      },
    });
  });
});
