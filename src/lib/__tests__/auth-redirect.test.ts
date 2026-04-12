import { describe, expect, it } from "vitest";
import { buildLoginPath, resolvePostLoginPath } from "@/lib/auth-redirect";

describe("auth redirect helpers", () => {
  it("keeps safe internal callback paths", () => {
    expect(resolvePostLoginPath("/nominations/token-1")).toBe("/nominations/token-1");
  });

  it("falls back for invalid or external callback paths", () => {
    expect(resolvePostLoginPath(null)).toBe("/dashboard");
    expect(resolvePostLoginPath("https://evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("//evil.example")).toBe("/dashboard");
  });

  it("does not allow redirecting back to the login page", () => {
    expect(resolvePostLoginPath("/login")).toBe("/dashboard");
    expect(resolvePostLoginPath("/login?callbackUrl=%2Fadmin")).toBe("/dashboard");
  });

  it("builds a login URL with a preserved callback path", () => {
    expect(buildLoginPath("/nominations/token-1")).toBe(
      "/login?callbackUrl=%2Fnominations%2Ftoken-1"
    );
  });
});
