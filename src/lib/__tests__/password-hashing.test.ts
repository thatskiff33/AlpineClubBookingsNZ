import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  burnDummyPasswordCompare,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashPin,
  PASSWORD_BCRYPT_COST,
  UNUSABLE_PLACEHOLDER_PASSWORD_HASH,
  verifyPassword,
} from "../password-hashing";
import { realElapsedMs } from "./helpers/clock";

// Real cost-13 bcrypt, partly in pure-JS bcryptjs: about 3s a test on an idle
// machine, so the 5s default is too tight for a loaded CI shard.
describe("password hashing (#4934)", { timeout: 30_000 }, () => {
  it("keeps real, dummy and placeholder passwords at the same cost (#4639)", async () => {
    const hash = await hashPassword("test-password-only");
    expect(bcrypt.getRounds(hash)).toBe(PASSWORD_BCRYPT_COST);
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(bcrypt.getRounds(hash));
    expect(bcrypt.getRounds(UNUSABLE_PLACEHOLDER_PASSWORD_HASH)).toBe(bcrypt.getRounds(hash));
    expect(UNUSABLE_PLACEHOLDER_PASSWORD_HASH).not.toBe(DUMMY_PASSWORD_HASH);
    expect(await verifyPassword("test-password-only", hash)).toBe(true);
    expect(await burnDummyPasswordCompare("test-password-only")).toBe(false);
    for (const plain of ["", randomBytes(32).toString("hex")]) {
      expect(await verifyPassword(plain, UNUSABLE_PLACEHOLDER_PASSWORD_HASH)).toBe(false);
    }
  });

  it.each([10, 11, 12, 13])("reads bcryptjs hashes at cost %i with either prefix", async (cost) => {
    const hash = await bcrypt.hash("compatibility-test-only", cost);
    for (const prefix of ["$2a$", "$2b$"]) {
      const stored = prefix + hash.slice(4);
      expect(await verifyPassword("compatibility-test-only", stored)).toBe(true);
      expect(await verifyPassword("wrong", stored)).toBe(false);
    }
  });

  it("writes hashes bcryptjs can read and preserves the PIN cost policy", async () => {
    expect(await bcrypt.compare("new-password", await hashPassword("new-password"))).toBe(true);
    const pinHash = await hashPin("123456", 4);
    expect(bcrypt.getRounds(pinHash)).toBe(4);
    expect(await bcrypt.compare("123456", pinHash)).toBe(true);
  });

  it.each([
    ["a".repeat(100), "a".repeat(72) + "different suffix"],
    ["雪山🦜 café", "雪山🦜 cafe"],
    ["a".repeat(71) + "雪", "a".repeat(71) + "雨"],
    ["abc\u0000def", "abc"],
  ])("preserves bcryptjs byte truncation and Unicode behaviour for %j", async (plain, other) => {
    const oldHash = await bcrypt.hash(plain, 10);
    // Same native hash call as hashPassword; cost 10 keeps the bcryptjs
    // comparisons inside the default timeout and does not change truncation.
    const newHash = await hashPin(plain, 10);
    for (const candidate of [plain, other, "wrong"]) {
      const expected = await bcrypt.compare(candidate, oldHash);
      expect(await verifyPassword(candidate, oldHash)).toBe(expected);
      expect(await verifyPassword(candidate, newHash)).toBe(expected);
      expect(await bcrypt.compare(candidate, newHash)).toBe(expected);
    }
  });

  it("leaves the event loop responsive while a cost-13 compare is pending", async () => {
    let settled = false;
    const start = process.hrtime.bigint();
    const pending = verifyPassword("wrong", DUMMY_PASSWORD_HASH).finally(() => { settled = true; });
    try {
      await setImmediate();
      // A main-thread cost-13 compare takes hundreds of ms; 100 ms leaves
      // headroom for a loaded CI shard without hiding a blocking call.
      expect(realElapsedMs(start)).toBeLessThan(100);
      expect(settled).toBe(false);
    } finally {
      await pending;
    }
  });
});
