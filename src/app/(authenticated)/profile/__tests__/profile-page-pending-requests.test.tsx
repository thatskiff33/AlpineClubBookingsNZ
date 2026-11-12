/**
 * #4956: a request the member started that waits on someone else stays on the
 * profile, read from the server, until it resolves — an open deletion request
 * replaces the Request Account Deletion button, and an unexpired email-change
 * link is named in the Change Email card. Before this, both lived only in
 * browser state and vanished on reload.
 *
 * The Prisma doubles below hold ROWS and apply the page's own `where` to them,
 * so a closed request or an expired link is filtered by the page's query (the
 * shared open-status list, the frozen clock) rather than by the fixture.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletionRequestStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  deletionRequestFindFirst: vi.fn(),
  emailChangeTokenFindFirst: vi.fn(),
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
    webAuthnCredential: {
      findMany: async () => [],
    },
    deletionRequest: { findFirst: mocks.deletionRequestFindFirst },
    emailChangeToken: { findFirst: mocks.emailChangeTokenFindFirst },
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

type DeletionRow = { memberId: string; status: DeletionRequestStatus; createdAt: Date };
type TokenRow = { memberId: string; newEmail: string; expiresAt: Date; createdAt: Date };

let deletionRows: DeletionRow[] = [];
let tokenRows: TokenRow[] = [];

function newestFirst<T extends { createdAt: Date }>(rows: T[]) {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

async function renderProfilePage(
  searchParams: Record<string, string> = {},
) {
  return renderToStaticMarkup(
    await ProfilePage({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("ProfilePage pending requests (#4956)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deletionRows = [];
    tokenRows = [];
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.memberFindUnique.mockResolvedValue(member());
    mocks.requiresPaidSubscriptionForMemberForBooking.mockResolvedValue(false);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
    mocks.loadMemberFieldsFlags.mockResolvedValue({ showOccupation: false });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    mocks.memberHoldsRetiredRecoveryCodes.mockResolvedValue(false);
    mocks.deletionRequestFindFirst.mockImplementation(
      async ({ where }: { where: { memberId: string; status: { in: DeletionRequestStatus[] } } }) =>
        newestFirst(
          deletionRows.filter(
            (row) =>
              row.memberId === where.memberId &&
              where.status.in.includes(row.status),
          ),
        )[0] ?? null,
    );
    mocks.emailChangeTokenFindFirst.mockImplementation(
      async ({ where }: { where: { memberId: string; expiresAt: { gt: Date } } }) =>
        newestFirst(
          tokenRows.filter(
            (row) =>
              row.memberId === where.memberId &&
              row.expiresAt.getTime() > where.expiresAt.gt.getTime(),
          ),
        )[0] ?? null,
    );
  });

  describe("deletion request", () => {
    it.each(["PENDING", "APPROVAL_IN_PROGRESS"] as const)(
      "shows the dated notice instead of the button while the request is %s",
      async (status) => {
        deletionRows = [
          {
            memberId: "member-1",
            status,
            // 29 June in New Zealand, 28 June in UTC: the date is club time.
            createdAt: new Date("2026-06-28T20:00:00.000Z"),
          },
        ];

        const html = await renderProfilePage();

        expect(html).toContain(
          "You asked for your account to be deleted on 29 Jun 2026.",
        );
        expect(html).not.toContain("Request Account Deletion");
      },
    );

    it.each(["REJECTED", "COMPLETED"] as const)(
      "offers the button again once the only request is %s",
      async (status) => {
        deletionRows = [
          {
            memberId: "member-1",
            status,
            createdAt: new Date("2026-06-28T20:00:00.000Z"),
          },
        ];

        const html = await renderProfilePage();

        expect(html).toContain("Request Account Deletion");
        expect(html).not.toContain("You asked for your account to be deleted");
      },
    );

    it("keeps the admin text and never reads deletion requests for an admin", async () => {
      mocks.memberFindUnique.mockResolvedValue(member({ role: "ADMIN", accessRoles: [{ role: "ADMIN" }] }),
      );
      deletionRows = [
        {
          memberId: "member-1",
          status: "PENDING",
          createdAt: new Date("2026-06-28T20:00:00.000Z"),
        },
      ];

      const html = await renderProfilePage();

      expect(html).toContain(
        "Admin accounts cannot be self-deleted. Contact another admin.",
      );
      expect(html).not.toContain("You asked for your account to be deleted");
      expect(html).not.toContain("Request Account Deletion");
      expect(mocks.deletionRequestFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("email change", () => {
    it("names the pending address and when its link expires", async () => {
      tokenRows = [
        {
          memberId: "member-1",
          newEmail: "new-address@example.test",
          // 30 minutes after the frozen clock: 12:30 pm in New Zealand.
          expiresAt: new Date("2026-07-01T00:30:00.000Z"),
          createdAt: new Date("2026-06-30T22:30:00.000Z"),
        },
      ];

      const html = await renderProfilePage();

      expect(html).toContain("A change to <strong>new-address@example.test</strong>");
      expect(html).toMatch(/The link expires\s*1 Jul 2026, 12:30 pm\./);
      expect(html).toContain("Requesting again replaces it.");
    });

    it("shows nothing extra once the link has expired", async () => {
      tokenRows = [
        {
          memberId: "member-1",
          newEmail: "new-address@example.test",
          expiresAt: new Date("2026-06-30T23:59:59.000Z"),
          createdAt: new Date("2026-06-30T21:59:59.000Z"),
        },
      ];

      const html = await renderProfilePage();

      expect(html).not.toContain("new-address@example.test");
      expect(html).not.toContain("waiting for you to click the link");
    });

    it("does not show a pending change beside the email-changed banner", async () => {
      // Confirming the change consumes the token, so no row is left to read.
      const html = await renderProfilePage({ emailChanged: "true" });

      expect(html).toContain("Your email address has been updated successfully.");
      expect(html).not.toContain("waiting for you to click the link");
    });
  });
});
