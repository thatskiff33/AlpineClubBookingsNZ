import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  loadMemberFieldsFlags: vi.fn(),
  memberFindUnique: vi.fn(),
  memberHoldsRetiredRecoveryCodes: vi.fn(),
  requiresPaidSubscriptionForMemberForBooking: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  // The profile page now renders the client ProfilePhotoSection, which calls
  // useRouter() during render.
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
  },
}));

vi.mock("@/lib/two-factor", () => ({
  memberHoldsRetiredRecoveryCodes: mocks.memberHoldsRetiredRecoveryCodes,
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

import ProfilePage from "../page";

function moduleFlags(twoFactor: boolean) {
  return {
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
    twoFactor,
    analytics: false,
  };
}

function member(overrides: Record<string, unknown> = {}) {
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
    subscriptions: [],
    ...overrides,
  };
}

async function renderProfilePage() {
  return renderToStaticMarkup(
    await ProfilePage({ searchParams: Promise.resolve({}) }),
  );
}

describe("ProfilePage two-factor card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.memberFindUnique.mockResolvedValue(member());
    mocks.requiresPaidSubscriptionForMemberForBooking.mockResolvedValue(false);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
    mocks.loadMemberFieldsFlags.mockResolvedValue({ showOccupation: false });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    mocks.memberHoldsRetiredRecoveryCodes.mockResolvedValue(false);
  });

  it("hides the card when the module is off and the member is not enrolled", async () => {
    const html = await renderProfilePage();

    expect(html).not.toContain("Two-factor authentication");
    expect(html).not.toContain("Not enrolled");
    expect(mocks.loadEffectiveModuleFlags).toHaveBeenCalledOnce();
  });

  it("keeps the card visible for enrolled members when the module is off", async () => {
    mocks.memberFindUnique.mockResolvedValue(
      member({ twoFactorEnabled: true, twoFactorMethod: "TOTP" }),
    );

    const html = await renderProfilePage();

    expect(html).toContain("Two-factor authentication");
    expect(html).toContain("Enabled");
    expect(html).toContain("Method: Authenticator app");
    expect(html).toContain(
      "The club currently has two-factor sign-in disabled, but your account remains enrolled.",
    );
    expect(html).not.toContain("Enrollment is required");
  });

  it("tells an enrolled member whose recovery codes were retired by a key change to regenerate them (#4456)", async () => {
    mocks.memberFindUnique.mockResolvedValue(
      member({ twoFactorEnabled: true, twoFactorMethod: "TOTP" }),
    );
    mocks.memberHoldsRetiredRecoveryCodes.mockResolvedValue(true);

    const html = await renderProfilePage();

    expect(mocks.memberHoldsRetiredRecoveryCodes).toHaveBeenCalledExactlyOnceWith("member-1");
    expect(html).toContain('data-testid="retired-recovery-codes-notice"');
    expect(html).toContain("Your saved recovery codes no longer work");
    expect(html).toContain("Choose Regenerate codes to get a new set");
  });

  it("shows no retired-codes notice when the member's codes still work (#4456)", async () => {
    mocks.memberFindUnique.mockResolvedValue(
      member({ twoFactorEnabled: true, twoFactorMethod: "TOTP" }),
    );

    const html = await renderProfilePage();

    expect(html).not.toContain("retired-recovery-codes-notice");
  });

  it("keeps the existing not-enrolled guidance when the module is on", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));

    const html = await renderProfilePage();

    expect(html).toContain("Two-factor authentication");
    expect(html).toContain("Not enrolled");
    expect(html).toContain(
      "Enrollment is required the next time the club enables two-factor authentication.",
    );
  });

  it("renders dashboard drill-down anchors for credit and promo code sections", async () => {
    const html = await renderProfilePage();

    expect(html).toContain('id="account-credit"');
    expect(html).toContain('id="promo-codes"');
  });
});
