import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notificationPreference: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return (operation as (tx: unknown) => Promise<unknown>)({});
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

import { PUT } from "@/app/api/notifications/preferences/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/notifications/preferences", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Vitest",
      "X-Forwarded-For": "198.51.100.1",
    },
    body: JSON.stringify(body),
  });
}

describe("member notification preferences audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as never);
    vi.mocked(prisma.notificationPreference.findUnique).mockResolvedValue({
      memberId: "member-1",
      bookingConfirmation: true,
      bookingReminder: true,
      bookingBumped: true,
      bookingCancelled: true,
      choreRoster: true,
      marketingEmails: false,
    } as never);
    vi.mocked(prisma.notificationPreference.upsert).mockResolvedValue({
      memberId: "member-1",
      bookingConfirmation: true,
      bookingReminder: false,
      bookingBumped: true,
      bookingCancelled: true,
      choreRoster: true,
      marketingEmails: true,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
  });

  it("writes structured awaited audit metadata for changed preference keys", async () => {
    const res = await PUT(
      makeRequest({ bookingReminder: false, marketingEmails: true })
    );

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.notification_preferences.updated",
        actorMemberId: "member-1",
        subjectMemberId: "member-1",
        category: "account",
        severity: "important",
        metadata: {
          changedPreferenceKeys: ["bookingReminder", "marketingEmails"],
          changes: [
            {
              key: "bookingReminder",
              before: true,
              after: false,
            },
            {
              key: "marketingEmails",
              before: false,
              after: true,
            },
          ],
        },
        ipAddress: "198.51.100.1",
        userAgent: "Vitest",
      }),
    });
  });
});
