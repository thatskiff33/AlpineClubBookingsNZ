/**
 * The Club Currency & Locale page asks Xero for the organisation's base
 * currency only for an admin the REAL admin guard admits (#3633).
 *
 * A layout's gate does not stop its page rendering, so the page re-runs
 * `guardAdminLayout()` and hands the reader the guard's database-fresh member.
 * These cases drive the real guard and the real reader, with only the session,
 * the member row and the Xero edges stubbed, and pin that a finance viewer who
 * is deactivated, or who has not finished two-factor sign-in, never reaches
 * `getXeroConnectedOrganisation` — which would otherwise cost a live Xero call
 * and put the value into the page payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  memberFindUnique: vi.fn(),
  getXeroConnectedOrganisation: vi.fn(),
  getXeroConnectionStatus: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-pathname": "/admin/club-format", "x-request-method": "GET" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/auth-diagnostics", () => ({
  recordAuthBounce: async () => null,
}));
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: { member: { findUnique: honourSelect(mocks.memberFindUnique, "Member") } },
  };
});
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => ({ xeroIntegration: true }),
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroConnectionStatus: mocks.getXeroConnectionStatus,
}));
vi.mock("@/lib/xero-organisation", () => ({
  getXeroConnectedOrganisation: mocks.getXeroConnectedOrganisation,
}));

import ClubFormatPage from "@/app/(admin)/admin/club-format/page";
import { accessRoleDefinitionGrid } from "@/lib/__tests__/helpers/access-role-definition-grid";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";

function financeViewer(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    role: "USER",
    active: true,
    canLogin: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: [
      {
        role: null,
        roleDefinitionId: "ardef_finance_view",
        roleDefinition: accessRoleDefinitionGrid({ financeLevel: "VIEW" }),
      },
    ],
    ...overrides,
  };
}

function signIn(sessionOverrides: Record<string, unknown> = {}) {
  mocks.auth.mockResolvedValue({
    user: {
      id: "member-1",
      name: "Finance Viewer",
      email: "finance@example.org",
      role: "USER",
      canLogin: true,
      // The JWT carries the finance matrix it was minted with, so a page that
      // trusted the bare session WOULD let this viewer make Xero answer.
      adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), finance: "view" },
      ...sessionOverrides,
    },
  });
}

describe("Club Currency & Locale page: who makes Xero answer (#3633)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getXeroConnectionStatus.mockResolvedValue({ connected: true });
    mocks.getXeroConnectedOrganisation.mockResolvedValue({
      name: "Alpine Club",
      financialYearEndMonth: 3,
      shortCode: "!aBc12",
      baseCurrency: "AUD",
      readFailure: null,
    });
  });

  it("reads the base currency for an admitted finance viewer", async () => {
    signIn();
    mocks.memberFindUnique.mockResolvedValue(financeViewer());

    await ClubFormatPage();

    expect(mocks.getXeroConnectedOrganisation).toHaveBeenCalledTimes(1);
  });

  it("redirects a finance viewer who has not finished two-factor sign-in, before asking Xero", async () => {
    signIn({ twoFactorRequired: true, twoFactorVerified: false });
    mocks.memberFindUnique.mockResolvedValue(
      financeViewer({ twoFactorEnabled: true }),
    );

    await expect(ClubFormatPage()).rejects.toThrow(/^REDIRECT:/);
    expect(mocks.getXeroConnectionStatus).not.toHaveBeenCalled();
    expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
  });

  it("redirects a deactivated finance viewer, before asking Xero", async () => {
    signIn();
    mocks.memberFindUnique.mockResolvedValue(financeViewer({ active: false }));

    await expect(ClubFormatPage()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
  });
});
