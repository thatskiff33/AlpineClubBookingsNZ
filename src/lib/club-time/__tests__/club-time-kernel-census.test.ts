/**
 * Structural guards over the kernel itself (CT-2, #2990).
 *
 * These read `src/` OFF DISK, so `vitest related` cannot reach them from a diff
 * — there is no import edge from a changed file to this suite. Run them
 * explicitly, or let CI do it: that blind spot is documented in `AGENTS.md` and
 * has already caught this epic once.
 *
 * Every assertion here is a property the kernel's docblocks CLAIM. A claim
 * nothing checks is a comment, and this repository has shipped several of those
 * that stopped being true.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const KERNEL = path.join(ROOT, "src", "lib", "club-time");
const LODGE_DISPLAY = path.join(ROOT, "src", "components", "lodge-display");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) =>
  path.relative(ROOT, file).split(path.sep).join("/");

/**
 * The source with its COMMENTS removed.
 *
 * Every claim below is about what the code DOES, and every docblock in this
 * kernel names the thing its module is forbidden to do — `APP_TIME_ZONE`,
 * `resolvedOptions().timeZone`, `getUTCDate()`, `server-only`. A census that
 * scanned raw text would fail on its own explanations, which is the fastest way
 * to teach the next reader to delete the guard. String and template literals are
 * kept, because an import specifier is one.
 */
function withoutComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  let quote: string | null = null;
  while (index < source.length) {
    const char = source[index] as string;
    if (quote === null && char === "/") {
      const next = source[index + 1];
      if (next === "/") {
        const end = source.indexOf("\n", index);
        index = end === -1 ? source.length : end;
        continue;
      }
      if (next === "*") {
        const end = source.indexOf("*/", index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
    }
    if (quote === null && (char === '"' || char === "'" || char === "`")) {
      quote = char;
    } else if (quote !== null && char === "\\") {
      out.push(source.slice(index, index + 2));
      index += 2;
      continue;
    } else if (char === quote) {
      quote = null;
    }
    out.push(char);
    index += 1;
  }
  return out.join("");
}

const kernelFiles = walk(KERNEL).map((file) => ({
  rel: rel(file),
  text: withoutComments(readFileSync(file, "utf8")),
}));

describe("the census can see the kernel at all", () => {
  it("found every module it is about to make claims over", () => {
    // Every "nothing in the kernel does X" assertion below would pass perfectly
    // over an empty list.
    expect(kernelFiles.length).toBeGreaterThanOrEqual(9);
    expect(kernelFiles.map((file) => file.rel)).toContain(
      "src/lib/club-time/clock.ts",
    );
    expect(kernelFiles.map((file) => file.rel)).toContain(
      "src/lib/club-time/intl.ts",
    );
  });
});

describe("the comment stripper the census depends on", () => {
  it("removes comments and keeps string literals", () => {
    const source = [
      '// APP_TIME_ZONE in a line comment',
      '/* APP_TIME_ZONE in a block comment */',
      'const specifier = "server-only";',
      'const url = "https://example.test/not-a-comment";',
      'const kept = `APP_TIME_ZONE in a template`;',
    ].join("\n");
    const stripped = withoutComments(source);
    expect(stripped).not.toContain("line comment");
    expect(stripped).not.toContain("block comment");
    expect(stripped).toContain('"server-only"');
    expect(stripped).toContain("https://example.test/not-a-comment");
    expect(stripped).toContain("APP_TIME_ZONE in a template");
  });
});

describe("a calendar date can never be reached by a timezone", () => {
  it("keeps Date, Intl and process.env out of calendar-date.ts entirely", () => {
    const source =
      kernelFiles.find((file) => file.rel === "src/lib/club-time/calendar-date.ts")
        ?.text ?? "";
    expect(source.length).toBeGreaterThan(0);
    for (const forbidden of ["new Date", "Date.UTC", "Intl.", "process.env", "getTimezoneOffset"]) {
      expect(
        source.includes(forbidden),
        `INV-DATE-010: calendar-date.ts mentions \`${forbidden}\`. A club calendar day has ` +
          "no time of day and no zone, so the module that owns its identity and arithmetic " +
          "holds no clock and asks no runtime what day it is. Integer civil-calendar " +
          "arithmetic is what makes 'date-only never routes through an instant projection' " +
          "a property rather than a promise.",
      ).toBe(false);
    }
  });
});

describe("the kernel reads one clock, in one named place", () => {
  it("has exactly one argument-less `new Date()`, in clock.ts", () => {
    const sites = kernelFiles.flatMap((file) =>
      [...file.text.matchAll(/new Date\(\s*\)/g)].map(() => file.rel),
    );
    expect(
      sites,
      "The clock seam exists so that 'no business-day decision reads the host clock " +
        "directly' is a property a census can check. A second `new Date()` anywhere in " +
        "src/lib/club-time/** is an ambient clock read; take a ClubClock instead.",
    ).toEqual(["src/lib/club-time/clock.ts"]);
  });
});

describe("the kernel owns exactly one formatter factory", () => {
  it("constructs Intl.DateTimeFormat only in intl.ts", () => {
    const sites = kernelFiles.filter((file) =>
      file.text.includes("new Intl.DateTimeFormat"),
    );
    expect(sites.map((file) => file.rel)).toEqual(["src/lib/club-time/intl.ts"]);
  });

  it("freezes no formatter at module level, in any module", () => {
    /*
      The 41 frozen module-level constants this kernel replaces were frozen
      against `APP_TIME_ZONE` at import time, which is exactly what a persisted,
      changeable club timezone makes impossible. Re-introducing one inside the
      kernel would put the old defect back underneath the new API.
    */
    const frozen = kernelFiles.flatMap((file) =>
      [...file.text.matchAll(/^(?:export )?const \w+\s*(?::[^=]+)?=\s*new Intl\.DateTimeFormat/gm)].map(
        () => file.rel,
      ),
    );
    expect(frozen).toEqual([]);
  });

  it("pins the calendar-date formatter to UTC, in the source", () => {
    /*
      This one has to be a SOURCE assertion, and the reason is worth stating.
      Rendering a calendar day is an identity only because the UTC-midnight
      encoding is read back by a UTC-pinned formatter. Swap that `"UTC"` for
      `"Pacific/Auckland"` and every output in this repository stays
      byte-identical — because New Zealand is east of Greenwich, which is the
      exact assumption this epic exists to remove. No behavioural test can tell
      the two apart on this deployment, so the guard is on the pin itself.
    */
    const source =
      kernelFiles.find((file) => file.rel === "src/lib/club-time/intl.ts")?.text ??
      "";
    const body = source.slice(source.indexOf("export function formatCalendarDateShape"));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(
      /formatHouseShape\(\s*shape,\s*new Date\(`\$\{date\}T00:00:00\.000Z`\),\s*"UTC",?\s*\)/,
    );
  });

  it("never mentions APP_TIME_ZONE", () => {
    const mentions = kernelFiles
      .filter((file) => file.text.includes("APP_TIME_ZONE"))
      .map((file) => file.rel);
    expect(
      mentions,
      "INV-CONFIG-002: the kernel takes the club's zone as an argument and never reads " +
        "the environment for it. `APP_TIME_ZONE` is process.env.TZ, which is precisely " +
        "the competing authority this epic exists to retire. The locale still comes from " +
        "configuration; the zone never does.",
    ).toEqual([]);
  });

  it("never asks the host or the browser what zone it is in", () => {
    const mentions = kernelFiles
      .filter((file) => /resolvedOptions\(\)\s*\.\s*timeZone/.test(file.text))
      .map((file) => file.rel);
    expect(
      mentions,
      "A viewer in London must see the same club time as a viewer in Ohakune, so no " +
        "kernel module may resolve the zone from its own host. The zone travels as data " +
        "from the server that read it.",
    ).toEqual([]);
  });
});

describe("the legacy adapters are adapters, not a second implementation", () => {
  it("leaves no Intl.DateTimeFormat in nzst-date.ts or date-only.ts", () => {
    /*
      The equivalence suite catches a re-frozen formatter whose SHAPE drifts. It
      cannot catch one whose shape is identical — which is the likelier
      regression, because the obvious way to "fix" a formatting bug in an adapter
      is to build a formatter there. Two implementations that agree today are two
      implementations, and CT-6 has to delete one of them.
    */
    for (const adapter of ["src/lib/nzst-date.ts", "src/lib/date-only.ts"]) {
      const source = withoutComments(
        readFileSync(path.join(ROOT, adapter), "utf8"),
      );
      expect(source.length).toBeGreaterThan(0);
      expect(
        source.includes("new Intl.DateTimeFormat"),
        `${adapter} builds its own Intl.DateTimeFormat again. Both files are ` +
          "compatibility adapters over @/lib/club-time (CT-2, #2990) and CT-6 (#2991) " +
          "deletes them; a formatter here is a second rule system growing back under " +
          "the one the epic exists to establish.",
      ).toBe(false);
    }
  });

  it("keeps every zone-taking adapter pointed at the kernel", () => {
    const source = withoutComments(
      readFileSync(path.join(ROOT, "src/lib/date-only.ts"), "utf8"),
    );
    for (const delegated of [
      "startOfClubDay",
      "endOfClubDayExclusive",
      "clubCalendarDateOf",
      "clubToday",
    ]) {
      expect(source, `date-only.ts no longer delegates ${delegated}`).toContain(
        delegated,
      );
    }
  });
});

describe("the barrel stays reachable from the browser bundle", () => {
  it("keeps server-only and Prisma out of every module the barrel re-exports", () => {
    /*
      112 of the 400 files on the legacy temporal surfaces are `"use client"`, so
      `@/lib/club-time` has to be importable from a client component.
      `client-server-boundary-census.test.ts` (INV-OPS-013) is the repository-wide
      guard; this is the local one, so a kernel module that grows a Prisma import
      fails in its own suite rather than in a census three directories away.
    */
    const clientSafe = kernelFiles.filter(
      (file) => file.rel !== "src/lib/club-time/server.ts",
    );
    const leaks = clientSafe
      .filter(
        (file) =>
          file.text.includes('"server-only"') ||
          file.text.includes("@/lib/prisma"),
      )
      .map((file) => file.rel);
    expect(leaks).toEqual([]);
  });

  it("keeps the server binding in server.ts, where it is marked", () => {
    const server =
      kernelFiles.find((file) => file.rel === "src/lib/club-time/server.ts")
        ?.text ?? "";
    expect(server.startsWith('import "server-only";')).toBe(true);
  });
});

describe("the stay window is not an occupancy decision", () => {
  it("is imported by nothing that also expands guest nights", () => {
    /*
      The biggest risk in this whole issue is a later lane "helpfully" replacing a
      date-only occupancy test with a noon-instant comparison. INV-DATE-002 and
      INV-DATE-003 forbid it — capacity is the half-open lodge-night range and
      nothing else — and a census is what makes the ban enforceable rather than
      advisory.
    */
    const OWN_MODULES = new Set([
      "src/lib/club-time/stay-window.ts",
      "src/lib/club-time/index.ts",
      "src/lib/club-time/bound.ts",
    ]);
    // A cheap `includes` first over ~1,400 files, comment-stripping only what
    // survives it: stripping the whole tree costs seconds, and this case shares
    // a five-second budget with the rest of the file.
    const candidates = walk(path.join(ROOT, "src"))
      .map((file) => ({ rel: rel(file), raw: readFileSync(file, "utf8") }))
      .filter(
        (file) => !OWN_MODULES.has(file.rel) && file.raw.includes("stayWindow"),
      );
    // The scan must be able to SEE a mention, or it passes over an empty list
    // for ever. `bound.ts` is excluded above as the kernel's own binding, so the
    // suite that exercises the window is the witness that the walk still works.
    expect(candidates.length).toBeGreaterThan(0);
    const usesStayWindow = candidates
      .map((file) => ({ rel: file.rel, text: withoutComments(file.raw) }))
      .filter((file) => /\bstayWindow\b/.test(file.text));
    /*
      TWO DIRECTIONS, because a mutation probe found the first one alone was
      blind. Adding `stayWindow` to `booking-guest-stay-ranges.ts` ITSELF passed
      a census that only looked for files mentioning both the function and the
      expander's module name — the expander does not import itself. So the
      occupancy modules are named and checked directly as well.
    */
    const OCCUPANCY_MODULES = ["src/lib/booking-guest-stay-ranges.ts"];
    const alsoExpandsNights = usesStayWindow
      .filter((file) => file.text.includes("booking-guest-stay-ranges"))
      .map((file) => file.rel);
    const occupancyItself = OCCUPANCY_MODULES.filter((module) => {
      const source = withoutComments(
        readFileSync(path.join(ROOT, module), "utf8"),
      );
      return /\bstayWindow\b/.test(source);
    });
    expect(
      [...alsoExpandsNights, ...occupancyItself].sort(),
      "INV-DATE-002/INV-DATE-003: `stayWindow` derives the midday arrival and departure " +
        "INSTANTS. It is not, and must never become, the way a bed, a night or a presence " +
        "is decided — those stay on the date-only half-open [checkIn, checkOut) range.",
    ).toEqual([]);
    // And the named modules really exist, so the second check is not vacuous.
    for (const occupancyModule of OCCUPANCY_MODULES) {
      expect(
        readFileSync(path.join(ROOT, occupancyModule), "utf8").length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("the lobby wall no longer reasons from UTC midnight", () => {
  it("builds no date formatter of its own, in any display module", () => {
    /*
      Six modules in this folder each carried the same two-line label: hand a
      `YYYY-MM-DD` to `new Date(`${date}T00:00:00Z`)`, format the weekday with a
      CLUB-zone-pinned Intl and take the day-of-month from `getUTCDate()`. That is
      only self-consistent for a club east of Greenwich; for America/Denver the
      two halves name different days.
    */
    const displayFiles = walk(LODGE_DISPLAY).map((file) => ({
      rel: rel(file),
      text: withoutComments(readFileSync(file, "utf8")),
    }));
    expect(displayFiles.length).toBeGreaterThan(5);
    const builders = displayFiles
      .filter((file) => /new Intl\.DateTimeFormat/.test(file.text))
      .map((file) => file.rel);
    expect(
      builders,
      "A lobby-display module built its own date formatter. Every calendar-day label in " +
        "this folder is a club-time kernel house shape, which takes no zone at all.",
    ).toEqual([]);
  });

  it("derives no label from the UTC reading of a lodge night", () => {
    const displayFiles = walk(LODGE_DISPLAY).map((file) => ({
      rel: rel(file),
      text: withoutComments(readFileSync(file, "utf8")),
    }));
    const offenders = displayFiles
      .filter((file) => /getUTCDate\(\)|T00:00:00Z`\)/.test(file.text))
      .map((file) => file.rel);
    expect(
      offenders,
      "INV-DATE-010: no rule may be derived from the UTC reading of a date-only value. " +
        "A lodge night is a calendar day; format it as one.",
    ).toEqual([]);
  });
});
