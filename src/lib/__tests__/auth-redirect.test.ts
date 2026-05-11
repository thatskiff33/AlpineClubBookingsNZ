import { describe, expect, it } from "vitest";
import {
  buildBookingLoginPath,
  buildLoginPath,
  resolvePostLoginPath,
} from "@/lib/auth-redirect";

describe("auth redirect helpers", () => {
  it("keeps safe internal callback paths", () => {
    expect(resolvePostLoginPath("/nominations/token-1")).toBe("/nominations/token-1");
    expect(resolvePostLoginPath("/dashboard?tab=bookings")).toBe(
      "/dashboard?tab=bookings"
    );
  });

  it("falls back for invalid or external callback paths", () => {
    expect(resolvePostLoginPath(null)).toBe("/dashboard");
    expect(resolvePostLoginPath("https://evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("//evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("/%2f%2fevil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("/\\\\evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath(" /dashboard")).toBe("/dashboard");
    expect(resolvePostLoginPath("/dashboard\n/admin")).toBe("/dashboard");
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

  it("builds the booking login URL with the booking callback path", () => {
    expect(buildBookingLoginPath()).toBe("/login?callbackUrl=%2Fbook");
  });
});
