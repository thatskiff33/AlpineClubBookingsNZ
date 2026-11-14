import { describe, expect, it } from "vitest";

import { isNotModified, opaqueEtag } from "@/lib/http-validators";

const ETAG = opaqueEtag("1024:1751328000000:42");
const MODIFIED = new Date("2026-07-01T00:00:00.500Z");

function headers(init: Record<string, string>) {
  return new Headers(init);
}

describe("opaqueEtag", () => {
  it("is a quoted 32-hex digest that discloses nothing of its seed and changes with it", () => {
    expect(ETAG).toMatch(/^"[0-9a-f]{32}"$/);
    expect(ETAG).not.toContain("1024");
    expect(opaqueEtag("1025:1751328000000:42")).not.toBe(ETAG);
  });
});

describe("isNotModified", () => {
  const validators = { etag: ETAG, lastModified: MODIFIED };

  it("matches If-None-Match by tag, in a list, weakly, or by *", () => {
    expect(isNotModified(headers({ "if-none-match": ETAG }), validators)).toBe(true);
    expect(isNotModified(headers({ "if-none-match": `"a", ${ETAG}` }), validators)).toBe(true);
    expect(isNotModified(headers({ "if-none-match": `W/${ETAG}` }), validators)).toBe(true);
    expect(isNotModified(headers({ "if-none-match": "*" }), validators)).toBe(true);
    expect(isNotModified(headers({ "if-none-match": '"other"' }), validators)).toBe(false);
  });

  it("compares If-Modified-Since at the second an HTTP date carries", () => {
    const sameSecond = MODIFIED.toUTCString(); // drops the .500
    expect(isNotModified(headers({ "if-modified-since": sameSecond }), validators)).toBe(true);
    const before = new Date(MODIFIED.getTime() - 1000).toUTCString();
    expect(isNotModified(headers({ "if-modified-since": before }), validators)).toBe(false);
    expect(isNotModified(headers({ "if-modified-since": "not a date" }), validators)).toBe(false);
    expect(isNotModified(headers({ "if-modified-since": sameSecond }), { etag: ETAG })).toBe(false);
  });

  it("ignores If-Modified-Since when If-None-Match is present", () => {
    expect(
      isNotModified(
        headers({ "if-none-match": '"stale"', "if-modified-since": MODIFIED.toUTCString() }),
        validators,
      ),
    ).toBe(false);
  });

  it("is false for an unconditional request", () => {
    expect(isNotModified(headers({}), validators)).toBe(false);
  });
});
