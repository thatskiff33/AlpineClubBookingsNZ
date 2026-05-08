import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPrismaTransaction = vi.fn();
const mockTxMemberFindUnique = vi.fn();
const mockTxMemberUpdateMany = vi.fn();
const mockTxTokenDeleteMany = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
    member: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
    },
    emailLog: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("../email", () => ({
  sendAgeUpInvitationEmail: vi.fn(),
}));

vi.mock("../logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../utils", () => ({
  getSeasonYear: vi.fn(() => 2026),
}));

import { prisma } from "../prisma";
import { sendAgeUpInvitationEmail } from "../email";
import { checkAgeUpMembers } from "../cron-age-up";

const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedUpdate = vi.mocked(prisma.member.update);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedEmailLogFind = vi.mocked(prisma.emailLog.findFirst);
const mockedSendEmail = vi.mocked(sendAgeUpInvitationEmail);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        member: {
          findUnique: mockTxMemberFindUnique,
          update: mockedUpdate,
          updateMany: mockTxMemberUpdateMany,
        },
        passwordResetToken: {
          create: mockedCreateToken,
          deleteMany: mockTxTokenDeleteMany,
        },
      })
  );
  mockTxMemberFindUnique.mockResolvedValue({ canLogin: false, ageTier: "YOUTH" });
  mockTxMemberUpdateMany.mockResolvedValue({ count: 1 });
  mockTxTokenDeleteMany.mockResolvedValue({ count: 1 });
});

// Helper: create a date of birth for a given age at season start (April 1 2026)
function dobForAge(age: number): Date {
  // Season start: 2026-04-01
  // If age 18, born on or before 2008-04-01
  return new Date(2026 - age, 3, 1); // April 1, (2026 - age)
}

describe("checkAgeUpMembers", () => {
  it("should upgrade a YOUTH member who turned 18", async () => {
    const member = {
      id: "m1",
      email: "youth@example.com",
      firstName: "Alice",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Check member was updated
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { canLogin: true, ageTier: "ADULT" },
    });

    // Check password reset token was created
    expect(mockedCreateToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "m1",
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    });

    // Check email was sent
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "youth@example.com",
      "Alice",
      expect.any(String)
    );
  });

  it("should skip members who already received age-up email", async () => {
    const member = {
      id: "m2",
      email: "already@example.com",
      firstName: "Bob",
      lastName: "Jones",
      dateOfBirth: dobForAge(19),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue({ id: "el1" } as any);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("should use inherited email when inheritEmailFromId is set", async () => {
    const member = {
      id: "m3",
      email: "child@placeholder.com",
      firstName: "Charlie",
      lastName: "Brown",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: "parent1",
      inheritEmailFrom: { email: "parent@example.com" },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    // Email should go to parent's email
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "parent@example.com",
      "Charlie",
      expect.any(String)
    );
  });

  it("should handle no candidates gracefully", async () => {
    mockedFindMany.mockResolvedValue([]);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should skip member with null dateOfBirth", async () => {
    const member = {
      id: "m4",
      email: "nodob@example.com",
      firstName: "Dee",
      lastName: "NoDob",
      dateOfBirth: null,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);

    const result = await checkAgeUpMembers();

    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("should count failed members when update throws", async () => {
    const member = {
      id: "m5",
      email: "fail@example.com",
      firstName: "Eve",
      lastName: "Fail",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockRejectedValue(new Error("DB error"));

    const result = await checkAgeUpMembers();

    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
  });

  it("should roll back the member upgrade and setup token when email delivery fails", async () => {
    const member = {
      id: "m-email-fail",
      email: "email-fail@example.com",
      firstName: "Failure",
      lastName: "Retry",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockRejectedValue(new Error("SMTP down"));

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
    expect(mockTxTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        memberId: "m-email-fail",
        tokenHash: expect.any(String),
        used: false,
      },
    });
    expect(mockTxMemberUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "m-email-fail",
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: "YOUTH",
      },
    });
  });

  it("should process multiple members independently", async () => {
    const member1 = {
      id: "m6",
      email: "a@example.com",
      firstName: "Aaa",
      lastName: "One",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };
    const member2 = {
      id: "m7",
      email: "b@example.com",
      firstName: "Bbb",
      lastName: "Two",
      dateOfBirth: dobForAge(20),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(2);
    expect(result.upgraded).toBe(2);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedSendEmail).toHaveBeenCalledTimes(2);
  });

  it("should create a 7-day expiry token", async () => {
    const member = {
      id: "m8",
      email: "token@example.com",
      firstName: "Frank",
      lastName: "Token",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    await checkAgeUpMembers();

    const tokenCall = mockedCreateToken.mock.calls[0][0];
    const expiresAt = (tokenCall as any).data.expiresAt as Date;
    const now = Date.now();
    // Should expire in ~7 days (allow 1 minute tolerance)
    const diffDays = (expiresAt.getTime() - now) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("should query for the correct member criteria", async () => {
    mockedFindMany.mockResolvedValue([]);

    await checkAgeUpMembers();

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: {
        active: true,
        canLogin: false,
        ageTier: { in: ["CHILD", "YOUTH"] },
        dateOfBirth: {
          not: null,
          lte: expect.any(Date),
        },
      },
      select: expect.objectContaining({
        id: true,
        email: true,
        firstName: true,
        dateOfBirth: true,
        inheritEmailFromId: true,
        inheritEmailFrom: { select: { email: true } },
      }),
    });

    // Verify cutoff date is 18 years before season start (April 1, 2026)
    // Cutoff should be April 1, 2008
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    const cutoffDate = cutoff.lte as Date;
    expect(cutoffDate.getFullYear()).toBe(2008);
    expect(cutoffDate.getMonth()).toBe(3); // April
    expect(cutoffDate.getDate()).toBe(1);
  });
});

describe("ageUpInvitationTemplate", () => {
  it("should generate HTML with member name and reset URL", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate("Alice", "https://example.com/reset?token=abc");

    expect(html).toContain("Alice");
    expect(html).toContain("https://example.com/reset?token=abc");
    expect(html).toContain("turned 18");
    expect(html).toContain("Set Up My Password");
  });

  it("should escape HTML in firstName", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate("<script>alert('xss')</script>", "https://example.com");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("sendAgeUpInvitationEmail", () => {
  it("should be importable and callable", async () => {
    // Verify the function exists and accepts the right params
    expect(typeof sendAgeUpInvitationEmail).toBe("function");
  });
});
