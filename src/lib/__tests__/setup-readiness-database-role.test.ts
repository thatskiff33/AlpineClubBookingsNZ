import { describe, expect, it } from "vitest";
import { buildDatabaseRoleCheck } from "@/lib/setup-readiness-database-role";

describe("database role readiness (INV-OPS-017)", () => {
  it.each([
    [{ name: "operator", isSuperuser: true }, "warning"],
    [{ name: "application", isSuperuser: false }, "complete"],
    [undefined, "warning"],
  ] as const)("reports server facts without blocking: %j", (snapshot, status) => {
    const check = buildDatabaseRoleCheck(snapshot);
    expect(check.status).toBe(status);
    expect(check.status).not.toBe("blocked");
    expect(check.required).toBe(false);
    if (!snapshot) expect(check.message).toMatch(/not checked/i);
  });
});
