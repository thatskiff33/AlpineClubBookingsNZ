import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    familyGroupJoinRequest: {
      findMany: vi.fn(),
    },
  },
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { shouldShowMemberOnboarding } from "@/lib/member-onboarding";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma, true);
const mockedRequireActiveSessionUser = vi.mocked(requireActiveSessionUser);

const session = { user: { id: "member-1", role: "MEMBER" } } as any;

const completeMember = {
  id: "member-1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
  streetAddressLine1: "123 Main St",
  streetAddressLine2: null,
  streetCity: "Tokoroa",
  streetRegion: "Waikato",
  streetPostalCode: "3420",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalAddressLine2: null,
  postalCity: "Tokoroa",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
  role: "MEMBER",
  ageTier: "ADULT",
  active: true,
  canLogin: true,
  profileCompletedAt: new Date("2026-05-10T01:00:00.000Z"),
  detailsConfirmedAt: null,
  detailsConfirmedByMemberId: null,
  onboardingConfirmedAt: null,
  forcePasswordChange: false,
  familyGroupMemberships: [],
};

describe("member onboarding API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue(session);
    mockedRequireActiveSessionUser.mockResolvedValue(null);
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([]);
  });

  it("returns required onboarding status for an incomplete current member", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue({
      ...completeMember,
      phoneNumber: null,
    } as any);

    const { GET } = await import("@/app/api/member/onboarding/route");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shouldShow).toBe(true);
    expect(body.currentMember.status.isProfileComplete).toBe(false);
    expect(body.currentMember.status.missingFields).toContain("phoneNumber");
  });

  it("returns shouldShow false after self confirmation and onboarding completion", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue({
      ...completeMember,
      detailsConfirmedAt: new Date("2026-05-10T02:00:00.000Z"),
      detailsConfirmedByMemberId: "member-1",
      onboardingConfirmedAt: new Date("2026-05-10T02:00:00.000Z"),
    } as any);

    const { GET } = await import("@/app/api/member/onboarding/route");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shouldShow).toBe(false);
    expect(body.currentMember.needsOwnDetailsConfirmation).toBe(false);
  });

  it("sets self confirmation and onboarding timestamps idempotently", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue(completeMember as any);
    mockedPrisma.member.update.mockResolvedValue({
      ...completeMember,
      detailsConfirmedAt: new Date("2026-05-10T02:00:00.000Z"),
      detailsConfirmedByMemberId: "member-1",
      onboardingConfirmedAt: new Date("2026-05-10T02:00:00.000Z"),
    } as any);

    const { POST } = await import("@/app/api/member/onboarding/confirm/route");
    const res = await POST();

    expect(res.status).toBe(200);
    expect(mockedPrisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-1" },
        data: expect.objectContaining({
          detailsConfirmedAt: expect.any(Date),
          detailsConfirmedByMemberId: "member-1",
          onboardingConfirmedAt: expect.any(Date),
        }),
      })
    );
  });

  it("rejects confirmation when the current profile is incomplete", async () => {
    mockedPrisma.member.findUnique.mockResolvedValue({
      ...completeMember,
      streetCity: null,
    } as any);

    const { POST } = await import("@/app/api/member/onboarding/confirm/route");
    const res = await POST();

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.missingFields).toContain("streetCity");
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and non-member users", async () => {
    mockedAuth.mockResolvedValueOnce(null as any);
    const { POST } = await import("@/app/api/member/onboarding/confirm/route");

    expect((await POST()).status).toBe(401);

    mockedAuth.mockResolvedValue(session);
    mockedPrisma.member.findUnique.mockResolvedValue({
      ...completeMember,
      canLogin: false,
    } as any);

    expect((await POST()).status).toBe(403);

    mockedPrisma.member.findUnique.mockResolvedValue({
      ...completeMember,
      role: "ADMIN",
    } as any);

    expect((await POST()).status).toBe(403);
  });

  it("uses the active-session guard for inactive or force-password-change members", async () => {
    mockedRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Password change required" }), {
        status: 403,
      }) as any
    );

    const { GET } = await import("@/app/api/member/onboarding/route");
    const res = await GET();

    expect(res.status).toBe(403);
    expect(mockedPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("only gates MEMBER accounts before forced password change", () => {
    expect(
      shouldShowMemberOnboarding({
        ...completeMember,
        role: "ADMIN",
      })
    ).toBe(false);

    expect(
      shouldShowMemberOnboarding({
        ...completeMember,
        role: "LODGE",
      })
    ).toBe(false);

    expect(
      shouldShowMemberOnboarding({
        ...completeMember,
        forcePasswordChange: true,
      })
    ).toBe(false);
  });
});
