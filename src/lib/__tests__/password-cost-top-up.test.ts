/**
 * #5261: the real `burnPasswordCostShortfall`, with native bcrypt doubled so
 * the work it spends is counted rather than timed. Every auth suite mocks this
 * function; this suite proves the loop itself, so a wrong bound, an un-awaited
 * hash or an early return cannot quietly reopen the timing gap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockHash, mockVerify } = vi.hoisted(() => ({
  mockHash: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock("@node-rs/bcrypt", () => ({ hash: mockHash, verify: mockVerify }));

import {
  burnPasswordCostShortfall,
  DUMMY_PASSWORD_HASH,
  PASSWORD_BCRYPT_COST,
  UNUSABLE_PLACEHOLDER_PASSWORD_HASH,
} from "../password-hashing";

// Test-only encodings; only the cost field is read.
const at = (cost: number) => `$2b$${String(cost).padStart(2, "0")}$not-a-credential-test-only`;

beforeEach(() => {
  vi.clearAllMocks();
  mockHash.mockResolvedValue("$2b$13$discarded");
  mockVerify.mockResolvedValue(false);
});

describe("burnPasswordCostShortfall (#5261)", () => {
  it("hashes once at cost 12 after a refused cost-12 compare", async () => {
    expect(PASSWORD_BCRYPT_COST).toBe(13);
    await burnPasswordCostShortfall("wrong", at(12));
    expect(mockHash).toHaveBeenCalledExactlyOnceWith("wrong", { cost: 12 });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("spends nothing after a refused current-cost compare", async () => {
    await burnPasswordCostShortfall("wrong", at(PASSWORD_BCRYPT_COST));
    expect(mockHash).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("spends nothing for the no-password placeholder, already at the current cost", async () => {
    await burnPasswordCostShortfall("wrong", UNUSABLE_PLACEHOLDER_PASSWORD_HASH);
    expect(mockHash).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("falls back to one dummy compare for an unreadable hash", async () => {
    await burnPasswordCostShortfall("wrong", "not-a-bcrypt-hash");
    expect(mockVerify).toHaveBeenCalledExactlyOnceWith("wrong", DUMMY_PASSWORD_HASH);
    expect(mockHash).not.toHaveBeenCalled();
  });

  it("awaits each step in order before resolving", async () => {
    const settled: number[] = [];
    mockHash.mockImplementation(async (_plain: string, { cost }: { cost: number }) => {
      await new Promise((resolve) => setImmediate(resolve));
      settled.push(cost);
      return "$2b$13$discarded";
    });
    await burnPasswordCostShortfall("wrong", at(PASSWORD_BCRYPT_COST - 3));
    expect(settled).toEqual([
      PASSWORD_BCRYPT_COST - 3,
      PASSWORD_BCRYPT_COST - 2,
      PASSWORD_BCRYPT_COST - 1,
    ]);
  });
});
