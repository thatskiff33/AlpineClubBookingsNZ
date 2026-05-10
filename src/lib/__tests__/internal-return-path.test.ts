import { describe, expect, it } from "vitest";
import {
  buildProfilePathWithReturnTo,
  getSafeInternalReturnPath,
  resolveInternalReturnPath,
} from "@/lib/internal-return-path";

describe("internal return path helpers", () => {
  it("keeps internal paths with query strings and fragments", () => {
    expect(getSafeInternalReturnPath("/book?step=guests#review")).toBe(
      "/book?step=guests#review",
    );
    expect(getSafeInternalReturnPath(["/dashboard", "/book"])).toBe(
      "/dashboard",
    );
  });

  it("rejects external, protocol-relative, script, and malformed values", () => {
    const unsafeValues = [
      null,
      "",
      "https://example.com/book",
      "http://tacbookings.local/book",
      "//example.com/book",
      "javascript:alert(1)",
      "data:text/html,hi",
      " /dashboard",
      "/\\example.com",
      "/%2Fexample.com",
      "/book?bad=%",
    ];

    for (const value of unsafeValues) {
      expect(getSafeInternalReturnPath(value)).toBeNull();
    }
  });

  it("resolves to a safe fallback when needed", () => {
    expect(resolveInternalReturnPath("https://example.com", "/profile")).toBe(
      "/profile",
    );
    expect(resolveInternalReturnPath("/book", "/profile")).toBe("/book");
  });

  it("builds profile links with encoded safe return paths", () => {
    expect(buildProfilePathWithReturnTo("/book?step=guests#review")).toBe(
      "/profile?returnTo=%2Fbook%3Fstep%3Dguests%23review",
    );
    expect(buildProfilePathWithReturnTo("/book", "family-group")).toBe(
      "/profile?returnTo=%2Fbook#family-group",
    );
    expect(buildProfilePathWithReturnTo("https://example.com", "family-group")).toBe(
      "/profile#family-group",
    );
  });
});
