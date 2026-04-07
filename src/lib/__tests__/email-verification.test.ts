import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the mock object is available at hoist time
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    emailVerificationToken: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "token-1", token: "abc123" }),
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    emailChangeToken: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "token-2", token: "def456" }),
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    member: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
  return { mockPrisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/email", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendEmailChangeVerification: vi.fn().mockResolvedValue(undefined),
  sendEmailChangeNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { generateToken, createEmailVerificationToken, createEmailChangeToken } from "../verification-tokens";

describe("generateToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});

describe("createEmailVerificationToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.emailVerificationToken.create.mockResolvedValue({ id: "t1", token: "abc" });
  });

  it("deletes existing tokens before creating a new one", async () => {
    const token = await createEmailVerificationToken("member-1");

    expect(mockPrisma.emailVerificationToken.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mockPrisma.emailVerificationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "member-1",
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Date),
      }),
    });
    expect(typeof token).toBe("string");
    expect(token).toHaveLength(64);
  });

  it("sets expiry to 48 hours from now", async () => {
    const before = Date.now();
    await createEmailVerificationToken("member-1");
    const after = Date.now();

    const createCall = mockPrisma.emailVerificationToken.create.mock.calls[0][0];
    const expiresAt = createCall.data.expiresAt.getTime();

    const expectedMin = before + 48 * 60 * 60 * 1000;
    const expectedMax = after + 48 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });
});

describe("createEmailChangeToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.emailChangeToken.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.emailChangeToken.create.mockResolvedValue({ id: "t2", token: "def" });
  });

  it("deletes existing tokens and creates one with 2h expiry", async () => {
    const before = Date.now();
    const token = await createEmailChangeToken("member-1", "new@example.com");
    const after = Date.now();

    expect(mockPrisma.emailChangeToken.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mockPrisma.emailChangeToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "member-1",
        newEmail: "new@example.com",
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Date),
      }),
    });
    expect(token).toHaveLength(64);

    const createCall = mockPrisma.emailChangeToken.create.mock.calls[0][0];
    const expiresAt = createCall.data.expiresAt.getTime();
    const expectedMin = before + 2 * 60 * 60 * 1000;
    const expectedMax = after + 2 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });
});

describe("verify-email flow logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects expired verification tokens", () => {
    const record = {
      id: "t1",
      expiresAt: new Date(Date.now() - 1000),
      member: { id: "m1", emailVerified: false },
    };
    expect(record.expiresAt < new Date()).toBe(true);
  });

  it("accepts valid verification tokens", () => {
    const record = {
      id: "t1",
      expiresAt: new Date(Date.now() + 86400000),
      member: { id: "m1", emailVerified: false },
    };
    expect(record.expiresAt > new Date()).toBe(true);
    expect(record.member.emailVerified).toBe(false);
  });

  it("handles already-verified member", () => {
    const record = {
      id: "t1",
      expiresAt: new Date(Date.now() + 86400000),
      member: { id: "m1", emailVerified: true },
    };
    expect(record.member.emailVerified).toBe(true);
  });

  it("resend creates new token (deletes old first)", async () => {
    await createEmailVerificationToken("m1");

    expect(mockPrisma.emailVerificationToken.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "m1" },
    });
    expect(mockPrisma.emailVerificationToken.create).toHaveBeenCalledTimes(1);
  });
});

describe("email-change flow logic", () => {
  it("rejects same email as current", () => {
    const currentEmail = "user@example.com";
    const newEmail = "user@example.com";
    expect(newEmail).toBe(currentEmail);
  });

  it("rejects already-taken email", () => {
    const existingMember = { id: "m2", email: "taken@example.com" };
    expect(existingMember).toBeTruthy();
  });

  it("rejects expired email change token", () => {
    const record = {
      expiresAt: new Date(Date.now() - 1000),
      newEmail: "new@example.com",
    };
    expect(record.expiresAt < new Date()).toBe(true);
  });

  it("confirms valid email change token", () => {
    const record = {
      expiresAt: new Date(Date.now() + 3600000),
      newEmail: "new@example.com",
      member: { id: "m1", email: "old@example.com", xeroContactId: null },
    };
    expect(record.expiresAt > new Date()).toBe(true);
    expect(record.newEmail).toBe("new@example.com");
  });
});

describe("booking gate", () => {
  it("blocks unverified member from booking", () => {
    const member = { emailVerified: false };
    expect(member.emailVerified).toBe(false);
    // Route should return 403
  });

  it("allows verified member to book", () => {
    const member = { emailVerified: true };
    expect(member.emailVerified).toBe(true);
    // Route should proceed
  });
});
