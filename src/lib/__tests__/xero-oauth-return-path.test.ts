import { describe, expect, it } from "vitest";
import { sanitizeXeroOAuthReturnPath } from "@/lib/xero-oauth-state";
import { getAdminPage, resolveAdminHref } from "@/lib/admin-hubs";

// The post-OAuth return path (#2080) is attacker-influenceable (a query param
// that becomes a redirect target), so it must only ever resolve to a
// same-origin admin path. These cases pin the open-redirect defense.
describe("sanitizeXeroOAuthReturnPath", () => {
  it("accepts internal admin paths", () => {
    expect(sanitizeXeroOAuthReturnPath("/admin/xero/setup")).toBe(
      "/admin/xero/setup",
    );
    expect(sanitizeXeroOAuthReturnPath("/admin/integrations")).toBe(
      "/admin/integrations",
    );
  });

  it("accepts the Xero landing pages at either place, so the round-trip survives the switch (C5 #4802)", () => {
    // The connect step returns to Xero Setup, and the callback's default is Xero
    // Sync, each at its adminHref: the old path while off, the hub path once on.
    for (const id of ["xero", "xero-setup"] as const) {
      for (const live of [false, true]) {
        const landing = resolveAdminHref(getAdminPage(id), live);
        expect(sanitizeXeroOAuthReturnPath(landing), landing).toBe(landing);
        expect(sanitizeXeroOAuthReturnPath(`${landing}?step=connect`)).toBe(`${landing}?step=connect`);
      }
    }
    expect(resolveAdminHref(getAdminPage("xero-setup"), true)).toBe("/admin/finance/xero/setup");
  });

  it("rejects null / empty / non-admin paths", () => {
    expect(sanitizeXeroOAuthReturnPath(null)).toBeNull();
    expect(sanitizeXeroOAuthReturnPath(undefined)).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("/login")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("/admin")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("admin/xero")).toBeNull();
  });

  it("rejects protocol-relative, absolute-URL, and backslash open-redirects", () => {
    expect(sanitizeXeroOAuthReturnPath("//evil.example.com")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("https://evil.example.com")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("/admin/\\..\\evil")).toBeNull();
  });

  it("rejects CR/LF and other control characters (header injection)", () => {
    const crlf = "/admin/x" + String.fromCharCode(13, 10) + "Set-Cookie: x";
    const lf = "/admin/x" + String.fromCharCode(10) + "foo";
    const tab = "/admin/x" + String.fromCharCode(9) + "foo";
    expect(sanitizeXeroOAuthReturnPath(crlf)).toBeNull();
    expect(sanitizeXeroOAuthReturnPath(lf)).toBeNull();
    expect(sanitizeXeroOAuthReturnPath(tab)).toBeNull();
  });

  it("rejects `..` path-traversal segments", () => {
    expect(sanitizeXeroOAuthReturnPath("/admin/../login")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("/admin/xero/../../login")).toBeNull();
    expect(sanitizeXeroOAuthReturnPath("/admin/xero/..")).toBeNull();
  });

  it("still accepts admin paths (incl. a query) with no `..` segment", () => {
    expect(sanitizeXeroOAuthReturnPath("/admin/xero/setup?step=connect")).toBe(
      "/admin/xero/setup?step=connect",
    );
    // A dot-dot INSIDE a segment (not a full `..` segment) is not traversal.
    expect(sanitizeXeroOAuthReturnPath("/admin/xero..setup")).toBe(
      "/admin/xero..setup",
    );
  });
});
