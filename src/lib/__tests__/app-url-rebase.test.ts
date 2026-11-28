import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppBaseUrl, rebaseOntoAppOrigin } from "@/lib/app-url";

/**
 * GHSA-q9f4-243m-6f54. The site's address comes from configuration only, and a
 * caller-supplied page address keeps its path, query and fragment and nothing
 * else. These are the two rules every link the club sends, stores or shows
 * relies on.
 */
describe("the site's own origin", () => {
  const original = process.env.NEXTAUTH_URL;

  beforeEach(() => {
    process.env.NEXTAUTH_URL = "https://club.example";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = original;
  });

  it("takes no fallback, so no caller can hand it a request's origin", () => {
    expect(getAppBaseUrl.length).toBe(0);
    expect(
      (getAppBaseUrl as (...args: unknown[]) => string)("https://evil.example")
    ).toBe("https://club.example");
  });

  it("uses the built-in default when nothing is configured, never a request", () => {
    delete process.env.NEXTAUTH_URL;
    expect(getAppBaseUrl()).toBe("http://localhost:3000");
  });

  it.each([
    ["/book?step=review#guests", "https://club.example/book?step=review#guests"],
    ["?page=2", "https://club.example/?page=2"],
    ["#top", "https://club.example/#top"],
    ["https://club.example/bookings", "https://club.example/bookings"],
    ["https://evil.example/bookings?x=1#y", "https://club.example/bookings?x=1#y"],
    ["http://evil.example:8080/a/b", "https://club.example/a/b"],
    ["//evil.example/phish", "https://club.example/phish"],
    ["https://club.example//evil.example/phish", "https://club.example/evil.example/phish"],
    ["https://club.example///evil.example", "https://club.example/evil.example"],
    ["https://user:secret@evil.example/phish", "https://club.example/phish"],
    ["https://club.example@evil.example/phish", "https://club.example/phish"],
    ["HTTPS://EVIL.EXAMPLE/Path", "https://club.example/Path"],
    ["  /book  ", "https://club.example/book"],
    ["/\t/evil.example/x", "https://club.example/x"],
    ["/%2f%2fevil.example/x", "https://club.example/%2f%2fevil.example/x"],
    ["/..//evil.example/x", "https://club.example/evil.example/x"],
    ["/%2e%2e//evil.example/x", "https://club.example/evil.example/x"],
    ["/a?next=https://evil.example/#javascript:alert(1)", "https://club.example/a?next=https://evil.example/#javascript:alert(1)"],
  ])("keeps only the page of this site: %s", (input, expected) => {
    const rebased = rebaseOntoAppOrigin(input);
    expect(rebased).toBe(expected);
    expect(new URL(rebased as string).origin).toBe("https://club.example");
  });

  it.each([
    "",
    "   ",
    "dashboard",
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "ftp://club.example/file",
    "mailto:someone@club.example",
    "\\\\evil.example\\phish",
    "http://",
  ])("refuses what is not a relative reference or a web address: %j", (input) => {
    expect(rebaseOntoAppOrigin(input)).toBeNull();
  });

  it("follows the configured origin, including its port, and drops its path", () => {
    process.env.NEXTAUTH_URL = "http://localhost:3001/ignored/path";
    expect(rebaseOntoAppOrigin("https://evil.example/book")).toBe(
      "http://localhost:3001/book"
    );
  });
});
