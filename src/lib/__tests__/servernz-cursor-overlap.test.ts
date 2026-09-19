import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * The one home of the ServerNZ cursor overlap (#2995, #3449).
 *
 * The arithmetic itself is proved end-to-end through each consumer's own
 * suite — `servernz-other-lodges-sync.test.ts` carries the spellings, the
 * rewind and the pass-through, `club-post-mirror.test.ts` the mirror's shape of
 * the same. What is pinned HERE is the single-source-of-truth property those
 * suites cannot see (`INV-SSOT-001`): that the window and its helpers are
 * defined once, and that both pulls import that definition rather than
 * carrying a copy that can drift.
 */

const mockLoggerWarn = vi.fn();

vi.mock("@/lib/logger", () => ({
  default: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  PULL_CURSOR_OVERLAP_MS,
  advancedDownloadCursor,
  overlappedRequestCursor,
} from "@/lib/servernz-cursor-overlap";

const HOME = "src/lib/servernz-cursor-overlap.ts";
const CONSUMERS = [
  "src/lib/servernz-other-lodges-sync.ts",
  "src/lib/club-post-mirror.ts",
];

function source(relativePath: string): string {
  return stripComments(
    readFileSync(path.resolve(process.cwd(), relativePath), "utf8"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the overlap has one home (INV-SSOT-001)", () => {
  it("defines the window once, in the shared module, as one minute", () => {
    expect(PULL_CURSOR_OVERLAP_MS).toBe(60_000);
    const home = source(HOME);
    expect(home.match(/PULL_CURSOR_OVERLAP_MS\s*=/g)).toHaveLength(1);
  });

  it.each(CONSUMERS)("%s imports the overlap rather than minting its own", (file) => {
    const code = source(file);
    expect(code).toContain('from "@/lib/servernz-cursor-overlap"');
    expect(code).toContain("overlappedRequestCursor(");
    expect(code).toContain("advancedDownloadCursor(");
    // No second window under this or any other name, and no local re-statement
    // of the helpers. Comments are stripped first: both consumers NAME the
    // constant in prose that explains why the repeat is deliberate.
    expect(code).not.toMatch(/OVERLAP_MS\s*=/);
    expect(code).not.toMatch(/function (overlappedRequestCursor|advancedDownloadCursor)\b/);
    expect(code).not.toMatch(/parseInstant\(/);
  });
});

describe("overlappedRequestCursor", () => {
  it("returns null for no stored cursor, so an initial sync is untouched", () => {
    expect(overlappedRequestCursor(null, "test")).toBeNull();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("steps an instant back one window, in its own offset and separator", () => {
    expect(overlappedRequestCursor("2026-06-20T10:05:30.000Z", "test")).toBe(
      "2026-06-20T10:04:30.000Z",
    );
    expect(overlappedRequestCursor("2026-06-20 10:05:30-05:00", "test")).toBe(
      "2026-06-20 10:04:30.000-05:00",
    );
  });

  it("passes an opaque cursor through and names the calling sync in the warning", () => {
    expect(overlappedRequestCursor("tok-100", "shared-post mirror")).toBe("tok-100");
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { cursor: "tok-100" },
      expect.stringContaining("shared-post mirror"),
    );
    expect(mockLoggerWarn.mock.calls[0][1]).toContain("NOT being applied");
  });
});

describe("advancedDownloadCursor", () => {
  it("never moves an instant watermark backwards, and still takes a later one", () => {
    const stored = "2026-06-20T10:05:30.000Z";
    expect(advancedDownloadCursor(stored, "2026-06-20T10:04:30.000Z")).toBe(stored);
    expect(advancedDownloadCursor(stored, "2026-06-20T10:05:30.001Z")).toBe(
      "2026-06-20T10:05:30.001Z",
    );
  });

  it("lets the server's answer stand when either side is opaque or absent", () => {
    expect(advancedDownloadCursor("tok-100", "tok-200")).toBe("tok-200");
    expect(advancedDownloadCursor(null, "2026-06-20T10:05:30.000Z")).toBe(
      "2026-06-20T10:05:30.000Z",
    );
    expect(advancedDownloadCursor("2026-06-20T10:05:30.000Z", null)).toBeNull();
  });
});
