/**
 * Typed factories for common domain shapes used across tests.
 *
 * Each factory accepts a partial override and returns a fully-populated
 * record typed against the Prisma model so callers get type errors when
 * the schema changes. Use these instead of inline literals + `as any`.
 *
 * Factories use deterministic placeholder values so snapshot/expectation
 * code stays stable; pass overrides to differentiate records inside a
 * test.
 */
import type {
  Booking,
  BookingGuest,
  FamilyGroup,
  Member,
  MemberCredit,
  Payment,
  PaymentRefund,
} from "@prisma/client";

const FIXED_NOW = new Date("2026-05-25T00:00:00.000Z");

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

const baseMember: Member = {
  id: "member-1",
  email: "member-1@example.org",
  emailVerified: true,
  firstName: "Test",
  lastName: "Member",
  passwordHash: null,
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: null,
  role: "MEMBER",
  financeAccessLevel: "NONE",
  ageTier: "ADULT",
  joinedDate: null,
  active: true,
  canLogin: true,
  forcePasswordChange: false,
  parentMemberId: null,
  secondaryParentId: null,
  inheritParentEmail: false,
  inheritEmailFromId: null,
  familyGroupId: null,
  cancelledAt: null,
  cancelledReason: null,
  cancelledViaRequestId: null,
  archivedAt: null,
  archivedReason: null,
  archivedViaLifecycleActionRequestId: null,
  xeroContactId: null,
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
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as Member;

export function memberFactory(overrides: Partial<Member> = {}): Member {
  return { ...baseMember, ...overrides };
}

export function adminMemberFactory(overrides: Partial<Member> = {}): Member {
  return memberFactory({
    id: "admin-1",
    email: "admin@example.org",
    firstName: "Admin",
    lastName: "User",
    role: "ADMIN",
    ...overrides,
  });
}

const baseFamilyGroup: FamilyGroup = {
  id: "family-1",
  name: "Test Family",
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as FamilyGroup;

export function familyGroupFactory(
  overrides: Partial<FamilyGroup> = {},
): FamilyGroup {
  return { ...baseFamilyGroup, ...overrides };
}

const baseBooking: Booking = {
  id: "booking-1",
  memberId: "member-1",
  checkIn: asDate("2026-06-01"),
  checkOut: asDate("2026-06-02"),
  status: "CONFIRMED",
  totalPriceCents: 10000,
  discountCents: 0,
  finalPriceCents: 10000,
  hasNonMembers: false,
  nonMemberHoldUntil: null,
  draftExpiresAt: null,
  notes: null,
  expectedArrivalTime: null,
  createdById: null,
  requiresAdminReview: false,
  adminReviewReason: null,
  waitlistPosition: null,
  waitlistOfferedAt: null,
  waitlistOfferExpiresAt: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as Booking;

export function bookingFactory(overrides: Partial<Booking> = {}): Booking {
  return { ...baseBooking, ...overrides };
}

const baseBookingGuest: BookingGuest = {
  id: "guest-1",
  bookingId: "booking-1",
  firstName: "Guest",
  lastName: "One",
  ageTier: "ADULT",
  isMember: false,
  memberId: null,
  stayStart: asDate("2026-06-01"),
  stayEnd: asDate("2026-06-02"),
  priceCents: 10000,
  arrivedAt: null,
  departedAt: null,
  createdAt: FIXED_NOW,
} as BookingGuest;

export function bookingGuestFactory(
  overrides: Partial<BookingGuest> = {},
): BookingGuest {
  return { ...baseBookingGuest, ...overrides };
}

const basePayment: Payment = {
  id: "payment-1",
  bookingId: "booking-1",
  amountCents: 10000,
  stripePaymentIntentId: null,
  stripePaymentMethodId: null,
  stripeSetupIntentId: null,
  stripeCustomerId: null,
  xeroInvoiceId: null,
  xeroInvoiceNumber: null,
  status: "PENDING",
  refundedAmountCents: 0,
  changeFeeCents: 0,
  additionalPaymentIntentId: null,
  additionalAmountCents: 0,
  additionalPaymentStatus: null,
  xeroRefundCreditNoteId: null,
  creditAppliedCents: 0,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as Payment;

export function paymentFactory(overrides: Partial<Payment> = {}): Payment {
  return { ...basePayment, ...overrides };
}

const basePaymentRefund: PaymentRefund = {
  id: "refund-1",
  paymentId: "payment-1",
  paymentTransactionId: null,
  stripeRefundId: null,
  amountCents: 0,
  reason: null,
  status: "PENDING",
  errorCode: null,
  errorMessage: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as PaymentRefund;

export function paymentRefundFactory(
  overrides: Partial<PaymentRefund> = {},
): PaymentRefund {
  return { ...basePaymentRefund, ...overrides };
}

const baseMemberCredit: MemberCredit = {
  id: "credit-1",
  memberId: "member-1",
  amountCents: 0,
  reason: null,
  sourceBookingId: null,
  appliedBookingId: null,
  expiresAt: null,
  createdByMemberId: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as MemberCredit;

export function memberCreditFactory(
  overrides: Partial<MemberCredit> = {},
): MemberCredit {
  return { ...baseMemberCredit, ...overrides };
}

/**
 * Minimal Xero contact shape used in tests that mock the Xero client.
 * Kept as a plain object because the Xero SDK types are not surfaced
 * directly to most call sites.
 */
export type XeroContactFixture = {
  contactID: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
};

export function xeroContactFixture(
  overrides: Partial<XeroContactFixture> = {},
): XeroContactFixture {
  return {
    contactID: "xero-contact-1",
    name: "Test Member",
    firstName: "Test",
    lastName: "Member",
    emailAddress: "member-1@example.org",
    ...overrides,
  };
}
