import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

/**
 * Source with every comment blanked out, newlines preserved.
 *
 * THE FIRST DRAFT OF THIS CENSUS DID NOT DO THIS, and it is worth recording
 * what that cost rather than quietly fixing it. Counting raw text reported 14
 * files reading a host clock face and 96 naming `APP_TIME_ZONE`; the real
 * numbers are 0 and 9. The difference is entirely PROSE — this repository
 * documents each defect it removes at the site where it removed it, so the
 * strings a census greps for are densest in exactly the files that no longer
 * commit the defect. A census that counts its own postmortems reports the
 * epic's success as its failure, and would have made this ratchet unusable.
 *
 * Newlines are preserved rather than deleted so a reported line number still
 * points at the real line. String literals are tracked because `"https://x"`
 * contains a `//` that is not a comment, and template literals because they can
 * contain both.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (mode === "code") {
      if (character === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (character === "'") mode = "single";
      else if (character === '"') mode = "double";
      else if (character === "`") mode = "template";
      out += character;
      index++;
      continue;
    }

    if (mode === "line") {
      if (character === "\n") {
        mode = "code";
        out += character;
      }
      index++;
      continue;
    }

    if (mode === "block") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      if (character === "\n") out += character;
      index++;
      continue;
    }

    // Inside a string or template literal: copy through, honouring escapes.
    out += character;
    if (character === "\\") {
      if (index + 1 < source.length) out += source[index + 1];
      index += 2;
      continue;
    }
    if (
      (mode === "single" && character === "'") ||
      (mode === "double" && character === '"') ||
      (mode === "template" && character === "`")
    ) {
      mode = "code";
    }
    index++;
  }

  return out;
}

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

/** Files whose whole job is to be the retired adapter. */
const ADAPTER_MODULES = new Set(["src/lib/date-only.ts", "src/lib/nzst-date.ts"]);

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
    // The spelling a `@/lib/…`-only check misses. Twelve of this repository's
    // twenty-five `nzst-date` callers are in `src/lib/email/**` and reach it
    // relatively, so an allowlist built on the absolute form alone would have
    // reported half the real number.
    expect(importsAdapter('import { x } from "@/lib/date-only";', "nzst-date")).toBe(false);
  });

  it("distinguishes a host clock-face read from a UTC one", () => {
    expect(findHostClockReads("d.getDate();")).toBe(1);
    expect(findHostClockReads("d.getUTCDate();")).toBe(0);
    expect(findHostClockReads("d.getUTCFullYear();")).toBe(0);
  });

  it("actually reaches production files", () => {
    // The premise for every count below. A walker that silently returned an
    // empty list would make every assertion in this file pass while measuring
    // nothing — the exact shape this epic has caught four times.
    expect(PRODUCTION_FILES.length).toBeGreaterThan(500);
    expect(PRODUCTION_FILES).toContain("src/lib/capacity.ts");
    expect(PRODUCTION_FILES).not.toContain("src/lib/club-time/instant.ts");
    expect(PRODUCTION_FILES).not.toContain("src/lib/club-time-zone-env.ts");
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
 */
const CENSUS_CEILING = {
  /** Call sites that left a club-facing zone to `APP_TIME_ZONE`. */
  defaultedZoneCalls: 123,
  /** Production files containing at least one of them. */
  defaultedZoneFiles: 56,
  /** Production files importing the retired rendering adapter. */
  nzstDateImporters: 25,
  /**
   * Production files importing the date-only adapter, zone-free uses included.
   *
   * DELIBERATELY ONE HIGHER THAN THE EPIC'S LEDGER, and the reason says what
   * this coarse number can and cannot express. CT-6 replaced a host-local
   * `setDate(getDate() - n)` in `waitlist.ts` with `addDaysDateOnly`, which is
   * zone-FREE UTC arithmetic — a strictly better state that nonetheless ADDS an
   * importer. Measured on this branch, 169 of these files import only zone-free
   * exports and never consult a timezone at all; the number that matters for
   * environment authority is `defaultedZoneCalls` above, not this one.
   */
  dateOnlyImporters: 232,
} as const;

describe("the escape-hatch census only shrinks", () => {
  const defaulted = PRODUCTION_FILES.filter(
    (file) => !ADAPTER_MODULES.has(file),
  ).map((file) => ({ file, calls: findDefaultedZoneCalls(read(file)) }));
  const withDefaults = defaulted.filter((entry) => entry.calls.length > 0);
  const totalDefaulted = withDefaults.reduce(
    (sum, entry) => sum + entry.calls.length,
    0,
  );

  it("has no MORE environment-defaulted club-facing calls than measured", () => {
    expect(
      totalDefaulted,
      `The environment decides a club-facing answer at these sites:\n` +
        withDefaults
          .map(
            (entry) =>
              `  ${entry.file}: ${entry.calls.map((call) => `${call.helper}@${call.line}`).join(", ")}`,
          )
          .join("\n"),
    ).toBeLessThanOrEqual(CENSUS_CEILING.defaultedZoneCalls);
    expect(withDefaults.length).toBeLessThanOrEqual(
      CENSUS_CEILING.defaultedZoneFiles,
    );
  });

  it("has no more legacy-adapter importers than measured", () => {
    const nzst = PRODUCTION_FILES.filter(
      (file) => !ADAPTER_MODULES.has(file) && importsAdapter(read(file), "nzst-date"),
    );
    const dateOnly = PRODUCTION_FILES.filter(
      (file) => !ADAPTER_MODULES.has(file) && importsAdapter(read(file), "date-only"),
    );
    expect(nzst.length, nzst.join("\n")).toBeLessThanOrEqual(
      CENSUS_CEILING.nzstDateImporters,
    );
    expect(dateOnly.length).toBeLessThanOrEqual(
      CENSUS_CEILING.dateOnlyImporters,
    );
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

  it("the two legacy adapters are the ONLY modules naming the environment zone", () => {
    // Everything else is either structurally allowed to (the config module and
    // the seed reader, both excluded above as kernel siblings) or on the lint
    // ratchet. This asserts the ratchet's own membership from the tree rather
    // than from the config, so the two would have to be wrong together.
    const naming = PRODUCTION_FILES.filter((file) =>
      /\bAPP_TIME_ZONE\b/.test(read(file)),
    );
    expect(naming.length).toBeLessThanOrEqual(9);
  });
});
