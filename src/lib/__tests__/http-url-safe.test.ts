import { describe, expect, it } from "vitest";
import { isHttpUrl, isSafeHttpUrl } from "@/lib/http-url";

/**
 * The stricter rule for a booking page address (#55), the central server's
 * `isSafeHttpUrl`. The URL parser alone would repair or accept every refused
 * form below; `isHttpUrl` (every other caller's rule) still does.
 */
describe("isSafeHttpUrl (#55)", () => {
  it.each([
    "https://club.nz",
    "http://club.nz/book?lodge=1#rates",
    "HTTPS://Club.NZ/Book",
    "https://club.nz:8443/path",
  ])("accepts an ordinary address: %s", (value) => {
    expect(isSafeHttpUrl(value)).toBe(true);
  });

  it.each([
    ["a login before the host", "https://club.nz@evil.com"],
    ["a user name and password", "https://user:pass@club.nz"],
    ["a password with no user name", "https://:pass@club.nz"],
    ["a backslash", "http:\\\\evil.com"],
    ["a backslash in the path", "https://club.nz\\book"],
    ["a tab", "https:/\t/evil.com"],
    ["a newline", "https://club.nz/\nbook"],
    ["a space", "https://club.nz/book now"],
    ["a control character", "https://club.nz/\u0007"],
    ["a DEL character", "https://club.nz/\u007F"],
    ["no scheme", "club.nz"],
    ["a single slash", "https:/club.nz"],
    ["a leading space", " https://club.nz"],
    ["another scheme", "javascript:alert(1)"],
    ["ftp", "ftp://club.nz"],
  ])("refuses %s", (_label, value) => {
    expect(isSafeHttpUrl(value)).toBe(false);
  });

  it("is not a URL for nothing at all", () => {
    expect(isSafeHttpUrl("")).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });

  it("leaves isHttpUrl as it was for every other caller", () => {
    expect(isHttpUrl("https://club.nz@evil.com")).toBe(true);
    expect(isHttpUrl("http:\\\\evil.com")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  });
});
