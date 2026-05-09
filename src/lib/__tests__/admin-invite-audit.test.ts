// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetXeroContactGroupMemberships = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    booking: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendAdminPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendMemberSetupInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  getSeasonYear: vi.fn().mockReturnValue(2026),
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  getXeroContactIdsForGroup: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero-feature-flags", () => ({
  isXeroLiveMemberGroupLookupsEnabled: vi.fn().mockReturnValue(false),
}));

import { MemberPasswordActionButton } from "@/components/admin/member-password-action-button";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { POST as sendSetupInvite } from "@/app/api/admin/members/send-setup-invite/route";
import { GET as getMembers } from "@/app/api/admin/members/route";
import { GET as getMemberDetail } from "@/app/api/admin/members/[id]/route";
import { formatMemberAuditLogSummary } from "@/app/(admin)/admin/members/[id]/page";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as any;
const activeSessionMember = { active: true, forcePasswordChange: false };

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
    joinedDate: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    forcePasswordChange: false,
    passwordChangedAt: null,
    lastLoginAt: null,
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
    familyGroupMemberships: [],
    subscriptions: [],
    passwordResetTokens: [],
    ...overrides,
  };
}

function makeMemberDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
    xeroContactId: null,
    familyGroupMemberships: [],
    subscriptions: [],
    dependents: [],
    ...overrides,
  };
}

function makeReq(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("admin invite and audit workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(activeSessionMember as any);
    vi.mocked(prisma.member.count).mockResolvedValue(0);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _count: 0,
      _max: { checkOut: null },
      _sum: { finalPriceCents: null },
    } as any);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.passwordResetToken.create).mockResolvedValue({} as any);
    vi.mocked(prisma.passwordResetToken.deleteMany).mockResolvedValue({ count: 0 } as any);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes setup invite audit details as JSON", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      { id: "member-1", email: "alice@example.com", firstName: "Alice", lastName: "Smith" },
    ] as any);

    const res = await sendSetupInvite(
      makeReq("http://localhost/api/admin/members/send-setup-invite", { memberIds: ["member-1"] })
    );

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.setup-invite-sent",
        memberId: "admin-1",
        targetId: "member-1",
        details: expect.any(String),
      })
    );
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(JSON.parse(auditCall.details ?? "")).toEqual({
      recipientEmail: "alice@example.com",
      recipientName: "Alice Smith",
      kind: "invite",
      expiryLabel: "7 days",
    });
  });

  it("returns member detail audit rows with actor data", async () => {
    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce(activeSessionMember as any)
      .mockResolvedValueOnce(makeMemberDetail() as any);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
      {
        id: "audit-1",
        action: "member.setup-invite-sent",
        memberId: "admin-1",
        targetId: "member-1",
        details: null,
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
      },
    ] as any);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      { id: "admin-1", firstName: "Ada", lastName: "Admin", email: "ada@example.com" },
    ] as any);

    const res = await getMemberDetail(makeReq("http://localhost/api/admin/members/member-1"), {
      params: Promise.resolve({ id: "member-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auditLogs[0].actor).toEqual({
      id: "admin-1",
      firstName: "Ada",
      lastName: "Admin",
      email: "ada@example.com",
    });
  });

  it("returns pendingInviteExpiresAt only for unexpired unused setup tokens", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      makeMemberListRow({
        id: "pending",
        passwordResetTokens: [
          { expiresAt: new Date("2026-05-08T12:00:00.000Z"), used: false },
        ],
      }),
      makeMemberListRow({
        id: "expired",
        passwordResetTokens: [
          { expiresAt: new Date("2026-04-30T12:00:00.000Z"), used: false },
        ],
      }),
    ] as any);
    vi.mocked(prisma.member.count).mockResolvedValue(2);

    const res = await getMembers(makeReq("http://localhost/api/admin/members"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members.find((member: { id: string }) => member.id === "pending").pendingInviteExpiresAt).toBe("2026-05-08T12:00:00.000Z");
    expect(body.members.find((member: { id: string }) => member.id === "expired").pendingInviteExpiresAt).toBeNull();
  });

  it("hides the row invite/reset button for non-login members", () => {
    render(
      React.createElement(MemberPasswordActionButton, {
        member: {
          canLogin: false,
          hasCompletedAccountSetup: false,
          pendingInviteExpiresAt: null,
        },
        onClick: vi.fn(),
      })
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows Resend Invite for members with a pending setup token", () => {
    render(
      React.createElement(MemberPasswordActionButton, {
        member: {
          canLogin: true,
          hasCompletedAccountSetup: false,
          pendingInviteExpiresAt: "2026-05-08T12:00:00.000Z",
        },
        onClick: vi.fn(),
      })
    );

    const button = screen.getByRole("button", { name: "Resend Invite" });
    expect(button.getAttribute("title")).toContain("Sent invite expires in 7 days");
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });

  it("formats structured invite audit rows with recipient, timestamp, and actor", () => {
    expect(
      formatMemberAuditLogSummary(
        {
          id: "audit-1",
          action: "member.setup-invite-sent",
          createdAt: "2026-05-01T12:00:00.000Z",
          details: JSON.stringify({
            recipientEmail: "alice@example.com",
            recipientName: "Alice Smith",
            kind: "invite",
            expiryLabel: "7 days",
          }),
          actor: {
            id: "admin-1",
            firstName: "Ada",
            lastName: "Admin",
            email: "ada@example.com",
          },
        },
        "1 May 2026, 12:00 pm"
      )
    ).toBe("Invited via email to alice@example.com on 1 May 2026, 12:00 pm by Ada Admin");
  });
});
