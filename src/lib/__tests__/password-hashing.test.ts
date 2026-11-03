import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, PASSWORD_BCRYPT_COST } from "../password-hashing";

describe("password comparison work factor (#4639)", () => {
  it("uses the same bcrypt cost for refused sign-ins and newly stored passwords", async () => {
    const passwordHash = await bcrypt.hash("test-password-only", PASSWORD_BCRYPT_COST);

    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(bcrypt.getRounds(passwordHash));
    expect(await bcrypt.compare("test-password-only", passwordHash)).toBe(true);
    expect(await bcrypt.compare("test-password-only", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
