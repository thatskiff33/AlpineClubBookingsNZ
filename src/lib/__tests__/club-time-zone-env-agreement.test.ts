import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";

/**
 * The two readings of the environment's timezone must not drift apart while both
 * exist (CT-1, #2989; epic #2988).
 *
 * For the length of this epic there are two of them. `APP_TIME_ZONE` in
 * `src/config/operational.ts` is the OLD one — the transitional bridge that every
 * call site CT-2 and CT-4 have not yet migrated still reads. The new one is
 * `readEnvironmentClubTimeZoneSeed()`, which exists only to SEED the persisted
 * club timezone once. **`APP_TIME_ZONE` is retired by CT-6**, and this file
 * retires with it.
 *
 * Until then they must read the same two variables in the same order, because
 * they are two descriptions of the same fact: "the zone this deployment is
 * currently effectively using". If one of them gained a variable the other did
 * not, an upgrade would persist a zone different from the one the un-migrated
 * call sites were still formatting with, and half the app would silently disagree
 * with the other half about what day it is.
 *
 * The pin below is total rather than illustrative:
 *
 *     (readEnvironmentClubTimeZoneSeed() ?? CLUB_TIME_ZONE_FALLBACK) === APP_TIME_ZONE
 *
 * for every combination of the two variables — set, unset, blank, and both at
 * once. Note it pins the RAW strings, not the validated answers: the club
 * timezone additionally refuses `NZT`-style values (that is CT-1's whole point,
 * and `club-time-zone.test.ts` covers it), whereas `APP_TIME_ZONE` will happily
 * carry one. What is pinned here is which variables are read and in what order.
 *
 * The behavioural pin cannot see a THIRD variable added to only one of the two
 * readings, because nothing in an assertion over `TZ` and `NEXT_PUBLIC_TZ`
 * enumerates the unknown. That gap is closed by the census at the bottom of this
 * file, which reads the source tree and fails if any file other than those two
 * reads a `*TZ` environment variable at all.
 *
 * STATED LIMIT: the census matches `process.env.X` reads, in dot and bracket
 * form, after block comments are stripped. It would not see a read routed
 * through a destructure (`const { TZ } = process.env`) or through a dynamically
 * built key, neither of which exists in this tree. Being a disk scan it has no
 * import edge to the files it reads, so `vitest related` cannot select it from a
 * diff and it is CI-caught rather than locally-selected — deliberately, and the
 * same trade-off `docs/TESTING.md` records for the other contract scanners.
 */

const hostTimeZone = captureHostTimeZone();
const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

const SRC = path.resolve(process.cwd(), "src");
const SCANNED_EXTENSIONS = [".ts", ".tsx"];

/** Every `process.env.NAME` / `process.env["NAME"]` read in `text`. */
const ENVIRONMENT_READ =
  /process\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([A-Za-z_$][\w$]*)["'`]\s*\])/g;

/**
 * Strip comments so a docblock that NAMES a variable is not counted as reading
 * one — the failure mode that tripped the #2440 published-content contract, and
 * which two comments in this tree (`config-self-heal-steps.ts` and the migration
 * verification fixture) would trip here.
 *
 * Block comments go entirely; a line comment is stripped only when it starts the
 * line, so a `//` inside a string literal (a URL) can never eat the code beside
 * it.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The `*TZ` environment variables `text` actually reads, in source order. */
function timeZoneEnvironmentVariablesRead(text: string): string[] {
  return [...withoutComments(text).matchAll(ENVIRONMENT_READ)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((name) => name.endsWith("TZ"));
}

function productionSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      productionSourceFiles(full, out);
    } else if (
      SCANNED_EXTENSIONS.includes(path.extname(entry.name)) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative paths, sorted, of every file under `src/` reading a `*TZ` var. */
function filesReadingATimeZoneEnvironmentVariable(): string[] {
  return productionSourceFiles(SRC)
    .filter(
      (file) =>
        timeZoneEnvironmentVariablesRead(readFileSync(file, "utf8")).length > 0,
    )
    .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
    .sort();
}

/** `APP_TIME_ZONE` is computed at import, so it needs a fresh module each time. */
async function readAppTimeZone(): Promise<string> {
  vi.resetModules();
  const operational = await import("@/config/operational");
  return operational.APP_TIME_ZONE;
}

function setEnvironment(tz: string | null, nextPublicTz: string | null): void {
  if (tz === null) {
    // Assign before deleting: an assignment is what invalidates Node's cached
    // zone (#2485). `hostTimeZone.restore()` puts the original back the same way.
    process.env.TZ = CLUB_TIME_ZONE_FALLBACK;
    delete process.env.TZ;
  } else {
    process.env.TZ = tz;
  }
  if (nextPublicTz === null) {
    delete process.env.NEXT_PUBLIC_TZ;
  } else {
    process.env.NEXT_PUBLIC_TZ = nextPublicTz;
  }
}

afterEach(() => {
  hostTimeZone.restore();
  if (originalNextPublicTz === undefined) {
    delete process.env.NEXT_PUBLIC_TZ;
  } else {
    process.env.NEXT_PUBLIC_TZ = originalNextPublicTz;
  }
});

afterAll(() => {
  vi.resetModules();
});

describe("the club-timezone seed and the transitional APP_TIME_ZONE read the same environment", () => {
  it.each([
    ["TZ alone", "America/Denver", null, "America/Denver"],
    ["NEXT_PUBLIC_TZ alone", null, "Europe/London", "Europe/London"],
    ["TZ wins over NEXT_PUBLIC_TZ", "America/Denver", "Europe/London", "America/Denver"],
    ["neither set", null, null, CLUB_TIME_ZONE_FALLBACK],
    ["a blank TZ falls through to NEXT_PUBLIC_TZ", "   ", "Europe/London", "Europe/London"],
    ["both blank fall through to the default", "   ", "  ", CLUB_TIME_ZONE_FALLBACK],
    ["surrounding whitespace is trimmed by both", "  America/Denver  ", null, "America/Denver"],
    ["an unusable value is still read by both", "NZT", null, "NZT"],
  ])(
    "agrees with %s",
    async (_label, tz, nextPublicTz, expected) => {
      setEnvironment(tz, nextPublicTz);

      const seed = readEnvironmentClubTimeZoneSeed();
      const appTimeZone = await readAppTimeZone();

      expect(appTimeZone).toBe(expected);
      expect(seed ?? CLUB_TIME_ZONE_FALLBACK).toBe(appTimeZone);
    },
  );

  it("is read in exactly two places in the source tree", () => {
    // The census that closes the pin's stated limit. Two readings of the
    // environment's timezone exist on purpose for the length of this epic; a
    // THIRD would be a second authority nobody had pinned to either, and the
    // behavioural cases above could not see it. Adding one has to be a decision,
    // which means updating this list and saying why.
    const found = filesReadingATimeZoneEnvironmentVariable();

    expect(found).toEqual([
      // The transitional bridge every not-yet-migrated call site still reads.
      // Retired by CT-6 (#2991), and this entry goes with it.
      "src/config/operational.ts",
      // The seed for the persisted club timezone — the only other reading.
      "src/lib/club-time-zone-env.ts",
    ]);
  });

  it("PREMISE: the census can actually see a reading", () => {
    // Without this leg the assertion above passes just as well when the scanner
    // matches nothing at all — a green built on a broken regex or an empty file
    // list, which is exactly how a census goes vacuous.
    expect(
      timeZoneEnvironmentVariablesRead(
        'const zone = process.env.TZ?.trim() || process.env["NEXT_PUBLIC_TZ"];',
      ),
    ).toEqual(["TZ", "NEXT_PUBLIC_TZ"]);
    // And it does NOT see one merely named in prose, which is what a docblock
    // saying "SQL cannot read `process.env.TZ`" would otherwise trip.
    expect(
      timeZoneEnvironmentVariablesRead(
        "/** SQL cannot read `process.env.TZ`, so the backfill runs at boot. */\nexport const x = 1;",
      ),
    ).toEqual([]);
    // A non-timezone variable is not this census's business.
    expect(
      timeZoneEnvironmentVariablesRead("const c = process.env.CURRENCY;"),
    ).toEqual([]);
  });

  it("shares the same hard-coded New Zealand default", async () => {
    // If one of the two ever changed its last-resort default, an install with no
    // TZ at all would persist one zone and format with another.
    setEnvironment(null, null);

    expect(readEnvironmentClubTimeZoneSeed()).toBeNull();
    await expect(readAppTimeZone()).resolves.toBe(CLUB_TIME_ZONE_FALLBACK);
    expect(CLUB_TIME_ZONE_FALLBACK).toBe("Pacific/Auckland");
  });
});
