/**
 * #4616 (INV-AUTH-008): the step-up challenge's mint and consume, against a
 * Prisma double — what is stored and what each statement asks for. What
 * PostgreSQL does with two consumers at once, and with replayed, expired and
 * other-member tokens, is `session-reauth-challenge.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({ name: "Test Club", bookingsName: "Test Club - Bookings" }),
}));

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  sessionReauthChallenge: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: "reauth-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  consumeSessionReauthChallenge,
  createSessionReauthChallenge,
} from "@/lib/session-reauth-challenge";
import { hashTwoFactorCode } from "@/lib/two-factor";

describe("the step-up challenge (#4616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-for-4616");
    vi.stubEnv("DATA_ENCRYPTION_KEYS", "");
  });

  it("stores only the keyed hash of a 256-bit token, bound to the member, for two minutes", async () => {
    const token = await createSessionReauthChallenge("officer-1");

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const created = mockPrisma.sessionReauthChallenge.create.mock.calls[0]?.[0];
    expect(created.data.memberId).toBe("officer-1");
    expect(created.data.tokenHash).toBe(hashTwoFactorCode(token));
    expect(created.data.tokenHash).not.toContain(token);
    expect(created.data.expiresAt.getTime()).toBe(Date.now() + 2 * 60 * 1000);
    // Housekeeping takes only this member's expired rows, so live ones
    // minted by a concurrent step-up are left to be consumed.
    expect(mockPrisma.sessionReauthChallenge.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "officer-1", expiresAt: { lte: new Date(Date.now()) } },
    });
  });

  it("mints a different token every time", async () => {
    const first = await createSessionReauthChallenge("officer-1");
    const second = await createSessionReauthChallenge("officer-1");
    expect(first).not.toBe(second);
  });

  it("consumes with one guarded delete, for this member, unexpired, and succeeds only on exactly one row", async () => {
    mockPrisma.sessionReauthChallenge.deleteMany.mockResolvedValueOnce({ count: 1 });

    expect(await consumeSessionReauthChallenge("officer-1", "raw-token")).toBe(true);
    expect(mockPrisma.sessionReauthChallenge.deleteMany).toHaveBeenCalledWith({
      where: {
        tokenHash: { in: [hashTwoFactorCode("raw-token")] },
        memberId: "officer-1",
        consumedAt: null,
        expiresAt: { gt: new Date(Date.now()) },
      },
    });

    mockPrisma.sessionReauthChallenge.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await consumeSessionReauthChallenge("officer-1", "raw-token")).toBe(false);
  });

  it("refuses an empty token without asking the database", async () => {
    expect(await consumeSessionReauthChallenge("officer-1", "")).toBe(false);
    expect(mockPrisma.sessionReauthChallenge.deleteMany).not.toHaveBeenCalled();
  });
});
