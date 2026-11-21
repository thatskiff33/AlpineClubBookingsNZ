/**
 * #5261: re-hashing a proved password at the current cost. Real bcrypt; the
 * Member write is a Prisma double. The race against a concurrent password
 * change on real PostgreSQL is `password-rehash.realdb.test.ts`.
 */
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUpdateMany, mockLogger } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { member: { updateMany: mockUpdateMany } } }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import {
  DUMMY_PASSWORD_HASH,
  hashPin,
  PASSWORD_BCRYPT_COST,
  verifyPassword,
} from "@/lib/password-hashing";
import { upgradePasswordHashAfterProof } from "@/lib/password-rehash";

const PLAIN = "rehash-test-password-only";

// Real cost-13 hashing, plus a pure-JS bcryptjs compare of it.
describe("upgradePasswordHashAfterProof (#5261)", { timeout: 30_000 }, () => {
  let olderHash: string;

  beforeEach(async () => {
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    vi.clearAllMocks();
    olderHash ??= await hashPin(PLAIN, PASSWORD_BCRYPT_COST - 1);
  });

  it("replaces a lower-cost hash with one at the current cost that old releases can read", async () => {
    expect(await upgradePasswordHashAfterProof({ memberId: "m1", plain: PLAIN, storedHash: olderHash })).toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const { where, data } = mockUpdateMany.mock.calls[0][0];
    // Guarded on the proved hash; writes nothing that would end sessions.
    expect(where).toEqual({ id: "m1", passwordHash: olderHash });
    expect(Object.keys(data)).toEqual(["passwordHash"]);
    expect(bcrypt.getRounds(data.passwordHash)).toBe(PASSWORD_BCRYPT_COST);
    expect(await verifyPassword(PLAIN, data.passwordHash)).toBe(true);
    expect(await bcrypt.compare(PLAIN, data.passwordHash)).toBe(true);
  });

  it("leaves a hash already at the current cost alone", async () => {
    expect(
      await upgradePasswordHashAfterProof({ memberId: "m1", plain: "x", storedHash: DUMMY_PASSWORD_HASH }),
    ).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("reports no upgrade when another writer changed the password first", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await upgradePasswordHashAfterProof({ memberId: "m1", plain: PLAIN, storedHash: olderHash })).toBe(false);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("never throws when the save fails", async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await upgradePasswordHashAfterProof({ memberId: "m1", plain: PLAIN, storedHash: olderHash })).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "m1" }),
      "Failed to upgrade stored password hash cost",
    );
  });
});
