import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * CT-6 (#2991) — the final escape-hatch census, as a RATCHET.
 *
 * ## Why a census as well as the lint guards
 *
 * `club-time-boundary-guard.test.ts` proves three classes fail mechanically.
 * This file counts the classes that CANNOT be expressed as a selector, and pins
 * the count so it may only fall:
 *
 * - **taking a zone-defaulting helper's default.** `formatDateOnlyForTimeZone(x)`
 *   and `formatDateOnlyForTimeZone(x, clubZone)` are the same call with a
 *   different arity. A lint rule could ban the one-argument form, but there are
 *   too many remaining call sites for a block-level exemption list to be
 *   readable — sixty files — so the honest instrument is a counted inventory
 *   that CI refuses to let grow;
 * - **the count of files still importing the retired adapters**, which is the
 *   epic's own definition-of-done measure for legacy retirement;
 * - **the classes that are now at ZERO**, asserted as zero rather than left
 *   unmeasured. A class nobody counts is a class nobody notices coming back.
 *
 * ## This suite is unreachable by `vitest related`
 *
 * It reads `src/` from disk, so it has no import edge to the files it scans and
 * the module graph cannot find it. `AGENTS.md` requires it be run BY NAME, and
 * `vitest run` silently ignores a named path that does not exist (#3120) — so
 * check the path exists before trusting a count that includes it.
 *
 * ## The scanner has its own tests, and they come first
 *
 * A census whose scanner is subtly wrong reports a comfortable number and
 * everybody believes it. Every counter below is a pure function of a source
 * string, exercised on synthetic inputs in the first block, INCLUDING the
 * near-misses it must not count. Only then is it turned on the tree.
 */

const ROOT = path.resolve(__dirname, "../../..");

/** Re-exported from its single home so existing importers keep resolving. */
export { stripComments };

/**
 * The six `@/lib/date-only` helpers whose `timeZone` parameter defaults to
 * `APP_TIME_ZONE`. Called with the zone, they are correct; called without it,
 * the ENVIRONMENT decides a club-facing answer.
 */
const ZONE_DEFAULTING_HELPERS = [
  "startOfDateOnlyForTimeZone",
  "endOfDateOnlyForTimeZone",
  "formatDateOnlyForTimeZone",
  "normalizeDateOnlyForTimeZone",
  "todayDateOnlyForTimeZone",
  "getTodayDateOnly",
] as const;

/** The two that take no date argument, so their zone is the FIRST parameter. */
const ZONE_IS_FIRST_ARGUMENT = new Set([
  "todayDateOnlyForTimeZone",
  "getTodayDateOnly",
]);

/** One call that left the zone to the environment. */
interface DefaultedCall {
  readonly helper: string;
  readonly line: number;
}

/**
 * Every call of a zone-defaulting helper that did NOT pass a zone.
 *
 * Argument counting is done by walking the call's parentheses and splitting on
 * TOP-LEVEL commas, not by a regular expression: a nested call or an object
 * literal contains commas of its own, and a regex that counted those would
 * report a defaulted call as a correct one. That is the direction of error that
 * hides work, so it is the one worth paying for.
 */
export function findDefaultedZoneCalls(source: string): DefaultedCall[] {
  const found: DefaultedCall[] = [];
  for (const helper of ZONE_DEFAULTING_HELPERS) {
    const pattern = new RegExp("\\b" + helper + "\\s*\\(", "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      // A definition or an import mention is not a call site.
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      if (/\b(function|import|export)\s[^\n]*$/.test(before)) continue;

      let index = match.index + match[0].length;
      let depth = 1;
      let current = "";
      const parts: string[] = [];
      while (index < source.length && depth > 0) {
        const character = source[index];
        if ("([{".includes(character)) depth++;
        else if (")]}".includes(character)) {
          depth--;
          if (depth === 0) break;
        }
        if (character === "," && depth === 1) {
          parts.push(current);
          current = "";
        } else current += character;
        index++;
      }
      if (current.trim() !== "") parts.push(current);

      const arity = parts.filter((part) => part.trim() !== "").length;
      const zoneGiven = ZONE_IS_FIRST_ARGUMENT.has(helper)
        ? arity >= 1
        : arity >= 2;
      if (!zoneGiven) {
        found.push({
          helper,
          line: source.slice(0, match.index).split("\n").length,
        });
      }
    }
  }
  return found;
}

/** Files importing the named legacy adapter, by any path spelling. */
export function importsAdapter(source: string, adapter: string): boolean {
  return new RegExp(
    'from\\s+["\'](?:@/lib/|\\.{1,2}/(?:[\\w./-]*/)?)' + adapter + '["\']',
  ).test(source);
}

/** Host clock-face reads and writes, the class the lint arm bans. */
export function findHostClockReads(source: string): number {
  return (
    source.match(
      /\.(?:getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|setFullYear|setMonth|setDate|setHours|setMinutes|setSeconds)\s*\(/g,
    ) ?? []
  ).length;
}

/**
 * `new Date(y, m, d)` — a LOCAL-midnight construction, in the host's zone.
 *
 * The issue's census list names this class and nothing was counting it: it is a
 * CONSTRUCTOR, so the host-clock lint arm (which matches method CALLS) and
 * {@link findHostClockReads} (which matches `.getX(`) are both blind to it. It
 * is the defect `INV-DATE-014` was raised for — #2474, where a browser built a
 * lodge night at its own midnight and named the wrong day.
 *
 * ARITY is what separates it from the correct spellings. `new Date(ms)` and
 * `new Date(iso)` take one argument, and `new Date(Date.UTC(y, m, d))` also
 * takes ONE at the top level because its commas are inside the nested call —
 * which is why this walks parentheses rather than counting commas, for the same
 * reason {@link findDefaultedZoneCalls} does.
 */
export function findLocalMidnightConstruction(source: string): number {
  let found = 0;
  const pattern = /new\s+Date\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let index = match.index + match[0].length;
    let depth = 1;
    let current = "";
    const parts: string[] = [];
    while (index < source.length && depth > 0) {
      const character = source[index];
      if ("([{".includes(character)) depth++;
      else if (")]}".includes(character)) {
        depth--;
        if (depth === 0) break;
      }
      if (character === "," && depth === 1) {
        parts.push(current);
        current = "";
      } else current += character;
      index++;
    }
    if (current.trim() !== "") parts.push(current);
    if (parts.filter((part) => part.trim() !== "").length >= 3) found++;
  }
  return found;
}

/** Direct `Temporal` use, which belongs only inside the kernel. */
export function findTemporalUse(source: string): number {
  return (
    source.match(/from\s+["'](?:@js-temporal\/polyfill|temporal-polyfill)["']/g)
      ?? []
  ).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") {
        walk(full, out);
      }
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(path.relative(ROOT, full).replaceAll("\\", "/"));
    }
  }
  return out;
}

/**
 * Production source only. The kernel is excluded by DIRECTORY and by the six
 * sibling modules that belong to the same subsystem — a directory-only
 * exclusion misses `club-time-zone.ts` and friends, which is the mistake the
 * first sweep of this census made.
 */
const KERNEL_SIBLINGS = new Set([
  "src/lib/club-time-zone.ts",
  "src/lib/club-time-zone-env.ts",
  "src/lib/club-time-zone-runtime.ts",
  "src/lib/club-time-zone-settings.ts",
  "src/lib/club-time-zone-admin-state.ts",
]);

const PRODUCTION_FILES = walk(path.join(ROOT, "src")).filter(
  (file) => !file.startsWith("src/lib/club-time/") && !KERNEL_SIBLINGS.has(file),
);

/**
 * Files whose whole job is to be the retired adapter.
 *
 * `src/lib/nzst-date.ts` USED TO BE HERE AND IS NOW DELETED (#3123). It was the
 * club's second date-rendering seam; the kernel is the only one left. The
 * assertion that it has not come back lives in `club-time-kernel-census.test.ts`,
 * which checks the path does not exist — a set entry for a deleted file would
 * read as though the module were still around.
 */
const ADAPTER_MODULES = new Set(["src/lib/date-only.ts"]);

/** A file's CODE, with its prose removed. See {@link stripComments}. */
const read = (file: string): string =>
  stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));

describe("the scanner counts what it claims to count", () => {
  it("counts a call that left the zone to the environment", () => {
    const found = findDefaultedZoneCalls(
      "const day = formatDateOnlyForTimeZone(booking.checkIn);",
    );
    expect(found).toEqual([
      { helper: "formatDateOnlyForTimeZone", line: 1 },
    ]);
  });

  it("does NOT count a call that passed one", () => {
    expect(
      findDefaultedZoneCalls(
        "const day = formatDateOnlyForTimeZone(booking.checkIn, clubZone);",
      ),
    ).toEqual([]);
  });

  it("is not fooled by a comma inside a nested call", () => {
    // The near-miss that matters. A regex counting commas would read two
    // arguments here and report this defaulted call as correct — an error in
    // the direction that hides work, which is why the scanner walks parens.
    expect(
      findDefaultedZoneCalls(
        "const day = formatDateOnlyForTimeZone(pick(booking, 'checkIn'));",
      ),
    ).toHaveLength(1);
  });

  it("is not fooled by a comma inside an object literal", () => {
    expect(
      findDefaultedZoneCalls(
        "const day = normalizeDateOnlyForTimeZone({ a: 1, b: 2 });",
      ),
    ).toHaveLength(1);
  });

  it("knows the two helpers whose zone is the FIRST argument", () => {
    // `getTodayDateOnly(zone)` HAS its zone; `getTodayDateOnly()` has not. A
    // scanner that applied the two-argument rule here would report every
    // correct call as a defaulted one and the ratchet would be unusable.
    expect(findDefaultedZoneCalls("getTodayDateOnly(clubZone);")).toEqual([]);
    expect(findDefaultedZoneCalls("getTodayDateOnly();")).toHaveLength(1);
  });

  it("blanks a comment without moving any line number", () => {
    const stripped = stripComments(
      "const a = 1;\n// getTodayDateOnly();\nconst b = 2;\n",
    );
    expect(findDefaultedZoneCalls(stripped)).toEqual([]);
    expect(stripped.split("\n")).toHaveLength(4);
  });

  it("blanks a block comment and a JSDoc the same way", () => {
    expect(
      findDefaultedZoneCalls(
        stripComments("/* getTodayDateOnly(); */\n/** getTodayDateOnly(); */"),
      ),
    ).toEqual([]);
  });

  it("does NOT treat a URL inside a string as a comment", () => {
    // The near-miss that would silently truncate real code: `//` appears inside
    // every https string in the tree, and a naive stripper would delete the
    // rest of the line -- including any call site after it.
    const stripped = stripComments(
      'const u = "https://example.test"; getTodayDateOnly();',
    );
    expect(stripped).toContain("https://example.test");
    expect(findDefaultedZoneCalls(stripped)).toHaveLength(1);
  });

  it("does not count the helper's own definition", () => {
    expect(
      findDefaultedZoneCalls(
        "export function getTodayDateOnly(timeZone = APP_TIME_ZONE): Date {",
      ),
    ).toEqual([]);
  });

  it("finds an adapter import by every path spelling", () => {
    expect(importsAdapter('import { x } from "@/lib/nzst-date";', "nzst-date")).toBe(true);
    expect(importsAdapter('import { x } from "../nzst-date";', "nzst-date")).toBe(true);
    expect(importsAdapter('import { x } from "./nzst-date";', "nzst-date")).toBe(true);
    // The spelling a `@/lib/…`-only check misses. When this was written, twelve
    // of the repository's twenty-five `nzst-date` callers sat in
    // `src/lib/email/**` and reached it relatively, so an allowlist built on the
    // absolute form alone would have reported half the real number. Both the
    // module and its callers are gone now (#3123), but the matcher still has to
    // handle every spelling — `date-only` is reached both ways today, and the
    // zero-assertion below would be worthless if it could only see one form.
    expect(importsAdapter('import { x } from "@/lib/date-only";', "nzst-date")).toBe(false);
  });

  it("distinguishes a host clock-face read from a UTC one", () => {
    expect(findHostClockReads("d.getDate();")).toBe(1);
    expect(findHostClockReads("d.getUTCDate();")).toBe(0);
    expect(findHostClockReads("d.getUTCFullYear();")).toBe(0);
  });

  it("enumerates exactly what git says is there", () => {
    // THE PREMISE FOR EVERY COUNT BELOW, and it is checked against a source
    // that shares no code with the walker.
    //
    // A floor — `toBeGreaterThan(500)` against a real population of 2,082 —
    // was the first version of this, and a review lens showed what it permits:
    // a walk regression dropping the whole of `src/app` leaves 1,230 files, so
    // the floor passes, a `toContain` anchor in `src/lib` passes, every ceiling
    // below passes, and seven-plus defaulted sites go unmeasured. Anchors do
    // not fix that either — they only ever prove the trees somebody remembered
    // to name.
    //
    // `git ls-files` is the independent instrument. It reads the index rather
    // than the filesystem and shares nothing with `walk()`, so the two can only
    // agree by both being right. Set equality means no subtree can vanish
    // silently, and it cannot go stale as the tree grows.
    const tracked = execSync("git ls-files src", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (file) =>
          /\.(ts|tsx)$/.test(file) &&
          !/\.(test|spec)\.(ts|tsx)$/.test(file) &&
          !file.includes("/__tests__/") &&
          !file.startsWith("src/lib/club-time/") &&
          !KERNEL_SIBLINGS.has(file),
      )
      .sort();

    expect([...PRODUCTION_FILES].sort()).toEqual(tracked);
    // And the exclusions really excluded something, so set equality above is
    // not two empty filters agreeing with each other.
    expect(PRODUCTION_FILES).toContain("src/lib/capacity.ts");
    expect(PRODUCTION_FILES).not.toContain("src/lib/club-time/instant.ts");
    expect(PRODUCTION_FILES).not.toContain("src/lib/club-time-zone-env.ts");
  });

  it("counts a local-midnight Date construction, which no selector sees", () => {
    // `new Date(y, m, d)` is a CONSTRUCTOR, so neither the host-clock lint arm
    // nor `findHostClockReads` above can see it — the issue's own census list
    // names the class and nothing was counting it.
    expect(findLocalMidnightConstruction("const d = new Date(2026, 7, 1);")).toBe(1);
    // `Date.UTC(...)` is ONE argument at the top level and is the correct
    // spelling, so it must not be counted.
    expect(
      findLocalMidnightConstruction("const d = new Date(Date.UTC(2026, 7, 1));"),
    ).toBe(0);
    // Neither is an ordinary instant or a parse.
    expect(findLocalMidnightConstruction('new Date("2026-08-01T00:00:00Z");')).toBe(0);
    expect(findLocalMidnightConstruction("new Date(ms);")).toBe(0);
  });
});

/**
 * The measured baseline. EVERY NUMBER HERE IS A CEILING AND MAY ONLY FALL.
 *
 * When a migration lands, lower the number in the same commit — that is the
 * whole mechanism. A test that failed because the count went DOWN is the
 * pleasant kind of failure and takes one line to resolve; a test that fails
 * because it went up is a new escape hatch, and the fix is the migration, not
 * the number.
 *
 * ## EVERY CEILING HERE IS TIGHT. NONE OF THIS HEADROOM IS DELIBERATE.
 *
 * Each number equals the live count at the commit that last touched it. There
 * is no slack, no rounding up and no allowance for work in flight — so if you
 * measure the tree and find fewer than a ceiling says, the ceiling is STALE and
 * lowering it is the fix, not a nice-to-have.
 *
 * The assertions below are `toBe`, NOT `toBeLessThanOrEqual`, and that is the
 * mechanism rather than a stylistic preference. This suite shipped with the
 * looser form for exactly one merge, and a review lens measured what it cost:
 * taking #3107/#3121 into the branch removed 42 sites and the suite stayed
 * green, leaving 42 units of headroom in which the count could silently regrow.
 * Hand-lowering the number closed that instance and left the mechanism intact,
 * and the epic branch has to move again before #2988 reaches `main`, so the
 * slack would simply have re-opened. A ratchet with slack in it is not a
 * ratchet.
 *
 * With `toBe`, a count that goes DOWN fails too — deliberately. That failure
 * takes one line to resolve and is the pleasant kind; it is also the only
 * signal that a migration has landed and this file needs its number moved.
 */
const CENSUS_CEILING = {
  /**
   * Call sites that left a club-facing zone to `APP_TIME_ZONE`. **NOW ZERO, AND
   * STRUCTURALLY SO — this counter is no longer the thing holding the line.**
   *
   * History, because the shape of the fix is the lesson. CT-6 first measured
   * 123 in 56 files; #3107/#3121 took 42; #3123 took the remaining 81 across
   * 52 files, in eight lanes.
   *
   * Then #3123 did the thing that made counting unnecessary: it **deleted the
   * `= APP_TIME_ZONE` defaults from all six `date-only.ts` helpers**, so
   * `timeZone` is a required argument. An unstated zone is now a COMPILE
   * ERROR. That is why this number can be asserted at zero rather than
   * ratcheted down towards it — the type system, not this scanner, is what a
   * new escape hatch now runs into first.
   *
   * KEEP THIS COUNTER ANYWAY, and keep it at zero. Two instruments, for the
   * reason stated throughout this file: a type signature can be widened back
   * to optional by one small edit that reads as a convenience, and the person
   * making it will not think of themselves as re-opening an epic. The endgame
   * of #3123 found exactly that shape one layer up — a `timeZone?: string` on
   * `computeMemberGuestConsentExpiry`, whose sole production caller passed
   * nothing, so it had silently been on the environment. A defaulted CALL is
   * what this scanner sees; a defaulted SIGNATURE is what the compiler sees.
   * Neither instrument sees both.
   */
  defaultedZoneCalls: 0,
  /** Production files containing at least one of them. Zero, and see above. */
  defaultedZoneFiles: 0,
  /**
   * Production files importing the date-only adapter, zone-free uses included.
   *
   * A COARSE NUMBER THAT DOES NOT MEASURE ENVIRONMENT AUTHORITY, and it is
   * worth being explicit about that now the number above is zero. Most of
   * these files import only zone-free exports — `parseDateOnly`,
   * `addDaysDateOnly`, `formatDateOnly` — and never consult a timezone at all.
   * A file can even JOIN this list by getting better: CT-6 replaced a
   * host-local `setDate(getDate() - n)` in `waitlist.ts` with `addDaysDateOnly`,
   * which is zone-free UTC arithmetic and a strictly better state that
   * nonetheless adds an importer.
   *
   * So this one is a size-of-surface tracker, not a defect count, and it can
   * legitimately move in either direction. It is `toBe` like the rest, which
   * means a change here fails the suite and asks for a human decision about
   * which direction it moved and why — that is the intended behaviour, not an
   * oversight.
   */
  dateOnlyImporters: 213,
  /**
   * `new Date(y, m, d)` — local midnight in the HOST's zone.
   *
   * Counted here because it is the one class on the issue's census list that no
   * lint selector reaches: a constructor, not a method call. Both live sites are
   * reviewed report-surface adapters, so this is a recurrence counter rather
   * than a backlog.
   */
  localMidnightConstructions: 3,
} as const;

describe("the escape-hatch census is exact, and only ever revised downward", () => {
  const defaulted = PRODUCTION_FILES.filter(
    (file) => !ADAPTER_MODULES.has(file),
  ).map((file) => ({ file, calls: findDefaultedZoneCalls(read(file)) }));
  const withDefaults = defaulted.filter((entry) => entry.calls.length > 0);
  const totalDefaulted = withDefaults.reduce(
    (sum, entry) => sum + entry.calls.length,
    0,
  );

  it("has EXACTLY the environment-defaulted club-facing calls measured", () => {
    expect(
      totalDefaulted,
      `The environment decides a club-facing answer at these sites:\n` +
        withDefaults
          .map(
            (entry) =>
              `  ${entry.file}: ${entry.calls.map((call) => `${call.helper}@${call.line}`).join(", ")}`,
          )
          .join("\n"),
    ).toBe(CENSUS_CEILING.defaultedZoneCalls);
    expect(withDefaults.length).toBe(CENSUS_CEILING.defaultedZoneFiles);
  });

  it("has EXACTLY the legacy-adapter importers measured", () => {
    const dateOnly = PRODUCTION_FILES.filter(
      (file) => !ADAPTER_MODULES.has(file) && importsAdapter(read(file), "date-only"),
    );
    expect(dateOnly.length).toBe(CENSUS_CEILING.dateOnlyImporters);
  });

  it("has no importer of the deleted rendering adapter, by any path spelling", () => {
    // `nzstDateImporters` was a ratchet that went 25 -> 13 -> 0 and then stopped
    // being a number at all, because #3123 deleted the module. This is the
    // zero-assertion that replaces it: a class nobody counts is a class nobody
    // notices coming back, and an import of a deleted file is a build error
    // only until somebody helpfully recreates it.
    const nzst = PRODUCTION_FILES.filter(
      (file) => !ADAPTER_MODULES.has(file) && importsAdapter(read(file), "nzst-date"),
    );
    expect(nzst, nzst.join("\n")).toEqual([]);
  });
});

describe("the classes CT-6 closed are at zero, and stay there", () => {
  it("no production file reads or writes a host clock face", () => {
    // The lint arm bans this, and this counts it independently. Two
    // instruments, because a lint rule that stopped resolving would report a
    // clean tree and so would a census that trusted the lint rule.
    const offenders = PRODUCTION_FILES.filter(
      (file) => findHostClockReads(read(file)) > 0,
    );
    expect(offenders).toEqual([]);
  });

  it("no production file outside the kernel imports Temporal", () => {
    const offenders = PRODUCTION_FILES.filter(
      (file) => findTemporalUse(read(file)) > 0,
    );
    expect(offenders).toEqual([]);
  });

  it("only the ratcheted modules name the environment zone, in ANY spelling", () => {
    // Everything else is either structurally allowed to (the config module and
    // the seed reader, both excluded above as kernel siblings) or on the lint
    // ratchet. This asserts that membership from the TREE rather than from the
    // config, so the two would have to be wrong together.
    //
    // EVERY SPELLING, and that is a correction rather than thoroughness. This
    // read used to be `/\bAPP_TIME_ZONE\b/` alone, which does not match
    // `process.env["TZ"]` — so for that one spelling the "two instruments"
    // claim this file makes was NOT true and the lint arm was the only thing
    // looking. The arm now closes the computed and destructured forms too; this
    // closes them here, so the pair is a pair for every spelling rather than
    // for most of them.
    const naming = PRODUCTION_FILES.filter((file) =>
      /\bAPP_TIME_ZONE\b|process\s*\.\s*env\s*(?:\.\s*(?:TZ|NEXT_PUBLIC_TZ)\b|\[\s*["'](?:TZ|NEXT_PUBLIC_TZ)["']\s*\])/.test(
        read(file),
      ),
    );
    // NINE WHEN CT-6 MEASURED IT, FIVE NOW. #3123 took four: `date-only.ts`
    // stopped naming it the moment its six `= APP_TIME_ZONE` defaults were
    // deleted — the adapter had been the single largest reason the environment
    // was reachable at all — and `member-guest-consent-labels.ts` came off when
    // the deferral its own docblock had declared was finally closed.
    //
    // The five left are structural rather than deferred: the config module that
    // defines the value, and four modules that legitimately describe the
    // ENVIRONMENT rather than the club. Lowering this further needs a reason
    // beyond tidiness — read each one before assuming it is a leftover.
    expect(naming, naming.join("\n")).toHaveLength(5);
  });

  it("counts the local-midnight constructions no selector can reach", () => {
    const offenders = PRODUCTION_FILES.map((file) => ({
      file,
      count: findLocalMidnightConstruction(read(file)),
    })).filter((entry) => entry.count > 0);
    // Three, in two files, both already reviewed: the admin report surface's
    // own `host-local-day.ts`, which says what it is in its name, and
    // `admin-dataset-reset-state.ts`, which is on the `date-fns` ratchet for
    // the same report-bucketing reason. A FOURTH would not have been noticed
    // before this counter existed, which is the whole point of adding it.
    expect(
      offenders.map((entry) => entry.file).sort(),
      offenders.map((entry) => entry.file + ": " + entry.count).join("\n"),
    ).toEqual([
      "src/app/(admin)/admin/reports/_components/host-local-day.ts",
      "src/lib/admin-dataset-reset-state.ts",
    ]);
    expect(
      offenders.reduce((sum, entry) => sum + entry.count, 0),
    ).toBe(CENSUS_CEILING.localMidnightConstructions);
  });
});
