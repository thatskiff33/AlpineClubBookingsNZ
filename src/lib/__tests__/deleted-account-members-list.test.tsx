// @vitest-environment jsdom

/**
 * #2620 — the members list must not present an erased account as an ordinary
 * switched-off one.
 *
 * Deletion anonymisation writes `active: false` and stamps neither `cancelledAt`
 * nor `archivedAt`, which is exactly the list's **Inactive** lifecycle filter
 * (`{ active: false }, { cancelledAt: null }`). So a deleted member appears in
 * the list an officer opens to undo a mistaken bulk deactivate, identical to the
 * members they meant to restore. Two halves are tested here: the response
 * carries a `deletedAccount` verdict, and the table turns that into a distinct
 * chip and a checkbox that cannot be ticked.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetXeroContactGroupMemberships = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    accessRoleDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    member: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    booking: {
      aggregate: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn(), findMany: vi.fn() },
    passwordResetToken: { create: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn(
    (email?: string | null) => email?.split("@")[1]?.toLowerCase() ?? null,
  ),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendAdminPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendMemberSetupInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  getXeroContactIdsForGroup: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero-feature-flags", () => ({
  isXeroLiveMemberGroupLookupsEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getMembers } from "@/app/api/admin/members/route";
import { MemberTable } from "@/app/(admin)/admin/members/_components/member-table";
import type { Member } from "@/app/(admin)/admin/members/_types";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
} as never;

function makeMemberListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
    role: "MEMBER",
    financeAccessLevel: "NONE",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    xeroContactId: null,
    cancelledAt: null,
    archivedAt: null,
    joinedDate: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    forcePasswordChange: false,
    passwordChangedAt: null,
    lastLoginAt: null,
    familyGroupMemberships: [],
    subscriptions: [],
    passwordResetTokens: [],
    ...overrides,
  };
}

const baseMember: Member = {
  id: "member-1",
  title: null,
  firstName: "Alice",
  lastName: "Summit",
  gender: null,
  occupation: null,
  email: "alice@example.test",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: "1990-01-01",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: false,
  xeroContactId: null,
  cancelledAt: null,
  cancelledReason: null,
  lifeMemberDate: null,
  comments: null,
  archivedAt: null,
  archivedReason: null,
  xeroContactGroupsLoaded: false,
  xeroContactGroups: [],
  subscriptionStatus: "PAID",
  subscriptionXeroInvoiceId: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  joinedDate: "2026-04-01",
  forcePasswordChange: false,
  hasCompletedAccountSetup: true,
  pendingInviteExpiresAt: null,
  canLogin: true,
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
  familyGroups: [],
  currentMembershipType: null,
};

function renderMemberTable(members: Member[]) {
  return render(
    <MemberTable
      members={members}
      loading={false}
      debouncedSearch=""
      selectedIds={new Set()}
      canEdit
      xeroOrgShortCode={null}
      sortBy="name"
      sortDir="asc"
      membersListPath="/admin/members"
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      onToggleSort={vi.fn()}
      onOpenPasswordActionDialog={vi.fn()}
    />,
  );
}

describe("#2620 the members list distinguishes a deleted account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    } as never);
    vi.mocked(prisma.member.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
  });

  afterEach(() => cleanup());

  it("flags the anonymised row and only the anonymised row", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      makeMemberListRow({
        id: "deactivated",
        active: false,
        email: "bob@example.com",
      }),
      makeMemberListRow({
        id: "deleted",
        active: false,
        firstName: "Deleted",
        lastName: "Member",
        email: "deleted-1a2b3c4d@deleted.invalid",
      }),
      makeMemberListRow({
        // A walk-in placeholder shares the reserved TLD but is an ordinary
        // member record, and must never be flagged.
        id: "walk-in",
        active: true,
        email: "walk-in-9f2c@no-email.invalid",
      }),
    ] as never);

    const res = await getMembers(
      new NextRequest("http://localhost/api/admin/members?lifecycleStatus=inactive"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ id: string; deletedAccount: boolean }>;
    };
    const flagById = Object.fromEntries(
      body.members.map((member) => [member.id, member.deletedAccount]),
    );
    expect(flagById).toEqual({
      deactivated: false,
      deleted: true,
      "walk-in": false,
    });
  });

  it("renders a Deleted chip and refuses to let the row be ticked", () => {
    renderMemberTable([
      { ...baseMember, id: "deactivated", firstName: "Bob", lastName: "Plain" },
      {
        ...baseMember,
        id: "deleted",
        firstName: "Deleted",
        lastName: "Member",
        email: "deleted-1a2b3c4d@deleted.invalid",
        deletedAccount: true,
      },
    ]);

    // The two rows read differently now: one Inactive, one Deleted.
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();

    expect(screen.getByLabelText("Select Bob Plain")).toBeEnabled();
    expect(screen.getByLabelText("Select Deleted Member")).toBeDisabled();
  });
});
