/**
 * The one MEMBER-FACING screen this change is visible on (#3103).
 *
 * The profile page inlined `${seasonYear}/${seasonYear + 1}` TWICE - once for
 * the current season beside the subscription badge, once per row of the
 * subscription history - and both asserted that a season spans two calendar
 * years. It does not under a December year-end, where the season starts in
 * January and `clubSeasonYear` returns the calendar year itself.
 *
 * Both now come from `seasonSelectLabel`, which derives the answer from the
 * club's configured year-end. The owner accepted on #3103 that this changes
 * what a member reads: `2026/2027` becomes `2026 - 2027 (Apr-Mar)`.
 *
 * ## Why the surrounding parentheses went
 *
 * The row read `Subscription ({seasonLabel})`. The derived label carries its own
 * parenthesised month range, so keeping them would render
 * `Subscription (2026 - 2027 (Apr-Mar))`. The nesting is asserted against below
 * rather than left to a screenshot, because it is the kind of thing a later edit
 * re-introduces by putting the brackets back.
 *
 * ## What each case is for
 *
 * - **March** is the shipped default: the season really spans two calendar
 *   years, so this is the case that pins the new member-visible string.
 * - **December** is the discriminator - the only year-end whose season is one
 *   calendar year, and therefore the only case that fails if either site is
 *   re-inlined. Note the season YEAR is 2026 under both year-ends at the frozen
 *   clock (1 July 2026 is inside season 2026 whether the season began in April
 *   or in January), so the two cases differ only in the label, which is exactly
 *   the axis under test.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  loadMemberFieldsFlags: vi.fn(),
  memberFindUnique: vi.fn(),
  requiresPaidSubscriptionForMemberForBooking: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.memberFindUnique } },
}));

vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));

vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: mocks.loadMemberFieldsFlags,
}));

vi.mock("@/lib/membership-type-policy", () => ({
  requiresPaidSubscriptionForMemberForBooking:
    mocks.requiresPaidSubscriptionForMemberForBooking,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("../profile-details-card", () => ({
  ProfileDetailsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ProfileDetailsPageActions: () => null,
  ProfileDetailsCard: () => <section>Profile details form</section>,
}));

vi.mock("../profile-section-card", () => ({
  ProfileSectionCard: ({
    children,
    id,
    title,
  }: {
    children: ReactNode;
    id?: string;
    title: string;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock("../change-email-form", () => ({
  ChangeEmailForm: () => <form>Change email form</form>,
}));

vi.mock("../notification-preferences", () => ({
  NotificationPreferences: () => <section>Notification preferences</section>,
}));

vi.mock("../family-group-section", () => ({
  FamilyGroupSection: () => <section>Family group section</section>,
}));

vi.mock("../account-credit-section", () => ({
  AccountCreditSection: () => <section>Account credit section</section>,
}));

vi.mock("../data-export-button", () => ({
  DataExportButton: () => <button type="button">Export data</button>,
}));

vi.mock("../delete-account-button", () => ({
  DeleteAccountButton: () => <button type="button">Delete account</button>,
}));

vi.mock("../membership-cancellation-panel", () => ({
  MembershipCancellationPanel: () => <section>Membership cancellation</section>,
}));

vi.mock("@/components/audit-timeline", () => ({
  AuditTimeline: () => <section>Audit timeline</section>,
}));

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
} from "@/lib/financial-year";
import ProfilePage from "../page";

const MODULE_FLAGS = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
  addressAutocomplete: false,
  groupBookings: false,
  lockers: false,
  induction: false,
  workParties: false,
  promoCodes: false,
  hutLeaders: false,
  communications: false,
  skifieldConditions: false,
  twoFactor: false,
  analytics: false,
};

function member() {
  return {
    id: "member-1",
    email: "member@example.test",
    firstName: "Mere",
    lastName: "Member",
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
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
    role: "MEMBER",
    accessRoles: [],
    ageTier: "ADULT",
    occupation: null,
    active: true,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    passwordChangedAt: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    canLogin: true,
    familyGroupMemberships: [],
    // The frozen clock is 1 July 2026, so 2026 is the current season under both
    // year-ends under test and 2025 is a past one.
    subscriptions: [
      { seasonYear: 2026, status: "PAID" },
      { seasonYear: 2025, status: "PAID" },
    ],
  };
}

async function renderProfilePage() {
  return renderToStaticMarkup(
    await ProfilePage({ searchParams: Promise.resolve({}) }),
  );
}

describe("the member profile page names a season by the club's year-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.memberFindUnique.mockResolvedValue(member());
    mocks.requiresPaidSubscriptionForMemberForBooking.mockResolvedValue(true);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
    mocks.loadMemberFieldsFlags.mockResolvedValue({ showOccupation: false });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(MODULE_FLAGS);
  });

  afterEach(() => {
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  });

  it("names both calendar years, in both places, under the March default", async () => {
    const html = await renderProfilePage();

    // The current-season row, and the two history rows.
    expect(html).toContain("2026 - 2027 (Apr-Mar)");
    expect(html).toContain("2025 - 2026 (Apr-Mar)");
    // Neither site kept the two-calendar-year template.
    expect(html).not.toContain("2026/2027");
    expect(html).not.toContain("2025/2026");
  });

  it("does not nest the label's brackets inside the subscription row's own", async () => {
    const html = await renderProfilePage();

    expect(html).toContain("Subscription 2026 - 2027 (Apr-Mar)");
    expect(html).not.toContain("Subscription (2026");
  });

  it("names ONE calendar year under a December year-end, in both places", async () => {
    // The discriminator: re-inline either site and this fails while the March
    // case above still passes.
    __setFinancialYearEndMonthForTesting(12);

    const html = await renderProfilePage();

    expect(html).toContain("Subscription 2026 (Jan-Dec)");
    expect(html).toContain("2025 (Jan-Dec)");
    expect(html).not.toContain("2026 - 2027");
    expect(html).not.toContain("2025 - 2026");
  });
});
