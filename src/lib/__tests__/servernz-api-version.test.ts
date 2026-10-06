import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SERVERNZ_EXPECTED_SERVER_VERSION,
  SERVER_VERSION_UNKNOWN,
  compareServerVersions,
  computeServerVersionStatus,
  describeServerVersionPause,
  isStoredServerVersionMismatch,
  parseServerVersion,
} from "@/lib/servernz-api-version";
import { sampleValue } from "@/lib/email-message-registry";
import { stripComments } from "./support/strip-comments";

/**
 * #49, `INV-INT-025`: the ONE rule for comparing the central server's API
 * version with the one this site was built for. The owner's decision on the
 * issue is exact integer equality of `major.minor`, never a float - `1.10` is
 * not `1.1` - and any difference, a minor-only one included, is a mismatch.
 */

describe("parseServerVersion", () => {
  it("reads a canonical major.minor as two integers", () => {
    expect(parseServerVersion("2.0")).toEqual({ major: 2, minor: 0 });
    expect(parseServerVersion("1.10")).toEqual({ major: 1, minor: 10 });
    expect(parseServerVersion("999.999")).toEqual({ major: 999, minor: 999 });
  });

  it.each([
    ["a leading zero", "01.0"],
    ["a leading zero in the minor", "1.01"],
    ["a patch component", "1.0.0"],
    ["a sign", "+1.0"],
    ["whitespace", " 1.0"],
    ["the unknown marker", SERVER_VERSION_UNKNOWN],
    ["an empty string", ""],
    ["four digits", "1000.0"],
  ])("refuses %s", (_label, raw) => {
    expect(parseServerVersion(raw)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    expect(parseServerVersion(1.0)).toBeNull();
    expect(parseServerVersion(null)).toBeNull();
    expect(parseServerVersion(undefined)).toBeNull();
  });
});

describe("compareServerVersions", () => {
  it("matches only an identical major AND minor", () => {
    expect(compareServerVersions("2.0", "2.0")).toBe(true);
    expect(compareServerVersions("2.0", "2.1")).toBe(false);
    expect(compareServerVersions("2.0", "3.0")).toBe(false);
  });

  it("tells 1.10 from 1.1 - the float trap the owner ruled out", () => {
    expect(compareServerVersions("1.10", "1.1")).toBe(false);
    expect(compareServerVersions("1.1", "1.10")).toBe(false);
    expect(compareServerVersions("1.10", "1.10")).toBe(true);
  });

  it("treats the unknown marker, a malformed value and a missing value as different", () => {
    expect(compareServerVersions(SERVER_VERSION_UNKNOWN, "2.0")).toBe(false);
    expect(compareServerVersions("01.0", "1.0")).toBe(false);
    expect(compareServerVersions(null, "2.0")).toBe(false);
    // Two malformed values are not "equal": neither is a version.
    expect(compareServerVersions("x", "x")).toBe(false);
  });
});

describe("computeServerVersionStatus / isStoredServerVersionMismatch", () => {
  it("is no-key whatever is stored while no API key is stored", () => {
    expect(computeServerVersionStatus(null, false)).toBe("no-key");
    expect(computeServerVersionStatus("9.9", false)).toBe("no-key");
  });

  it("is unchecked for a NULL answer with a key, which does NOT pause syncing", () => {
    expect(computeServerVersionStatus(null, true)).toBe("unchecked");
    expect(isStoredServerVersionMismatch(null)).toBe(false);
    expect(isStoredServerVersionMismatch(undefined)).toBe(false);
  });

  it("is match for the expected version and mismatch for anything else, 404 included", () => {
    expect(computeServerVersionStatus(SERVERNZ_EXPECTED_SERVER_VERSION, true)).toBe("match");
    expect(isStoredServerVersionMismatch(SERVERNZ_EXPECTED_SERVER_VERSION)).toBe(false);
    expect(computeServerVersionStatus("1.10", true)).toBe("mismatch");
    expect(computeServerVersionStatus(SERVER_VERSION_UNKNOWN, true)).toBe("mismatch");
    expect(isStoredServerVersionMismatch(SERVER_VERSION_UNKNOWN)).toBe(true);
  });

  it("is built for the server's current version", () => {
    // The constant IS the upgrade lever: changing it is how a site upgrade
    // clears a mismatch with nothing stored to reset.
    expect(parseServerVersion(SERVERNZ_EXPECTED_SERVER_VERSION)).not.toBeNull();
    expect(SERVERNZ_EXPECTED_SERVER_VERSION).toBe("2.1");
  });
});

describe("describeServerVersionPause", () => {
  it("names both numbers, and says what a 404 means instead of printing 'unknown'", () => {
    expect(describeServerVersionPause("2.0", "2.1")).toBe(
      "Syncing with the Alpine Central Server is paused: this site is built for server version 2.0 and the server reports 2.1. Nothing is sent or received until the two match.",
    );
    expect(describeServerVersionPause("2.0", SERVER_VERSION_UNKNOWN)).toMatch(
      /does not report a version/,
    );
  });

  it("is what the email editor previews as {{serverVersionNote}}", () => {
    // The registry's sample is hard-coded (the registry is editor-facing); this
    // keeps it equal to the composer so a wording change cannot leave a stale
    // sample behind.
    expect(sampleValue("serverVersionNote")).toBe(
      describeServerVersionPause(
        sampleValue("serverVersionExpected"),
        sampleValue("serverVersionActual"),
      ),
    );
  });
});

describe("no version string is ever read as a number (census)", () => {
  // The float comparison the owner ruled out can only come back through
  // `Number(` or `parseFloat(` applied to a version string. The three modules
  // that hold or compare versions are scanned here, with comments stripped so
  // prose about the trap is not counted as an instance of it.
  const MODULES = [
    "src/lib/servernz-api-version.ts",
    "src/lib/servernz-api.ts",
    "src/lib/servernz-version-check.ts",
  ];

  it.each(MODULES)("%s never calls Number() or parseFloat()", (file) => {
    const source = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
    expect(source).not.toMatch(/\bNumber\s*\(/);
    expect(source).not.toMatch(/\bparseFloat\s*\(/);
  });
});
