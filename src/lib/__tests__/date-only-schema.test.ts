import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { parseDateOnly } from "@/lib/date-only";
import {
  DATE_ONLY_INVALID_MESSAGE,
  dateOnlyStringSchema,
  parsedDateOnlySchema,
} from "@/lib/date-only-schema";

/**
 * #4931: a date-only request field is validated by ONE schema. Only the
 * predicate used to be shared, so the zod wrapper around it was copied into 27
 * files and two copies had drifted to other wording.
 */

const NOT_DAYS = ["2026-02-30", "2026-7-1", "2026-07-01T00:00:00Z", " 2026-07-01", "", "01/07/2026"];

describe("dateOnlyStringSchema", () => {
  it("keeps a real calendar day as the string it arrived as", () => {
    expect(dateOnlyStringSchema.parse("2026-07-01")).toBe("2026-07-01");
    expect(dateOnlyStringSchema.parse("2028-02-29")).toBe("2028-02-29");
  });

  it.each(NOT_DAYS)("refuses %j with the one message", (value) => {
    const result = dateOnlyStringSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([DATE_ONLY_INVALID_MESSAGE]);
  });

  it("keeps the wording 25 of the 27 replaced copies used", () => {
    expect(DATE_ONLY_INVALID_MESSAGE).toBe("Date must be YYYY-MM-DD");
  });
});

describe("parsedDateOnlySchema", () => {
  it("parses a real calendar day to its date-only instant", () => {
    const parsed = parsedDateOnlySchema.parse("2026-07-01");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parsed).toEqual(parseDateOnly("2026-07-01"));
  });

  it.each(NOT_DAYS)("refuses %j before it is parsed", (value) => {
    const result = parsedDateOnlySchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([DATE_ONLY_INVALID_MESSAGE]);
  });
});

describe("census: no file declares its own date-only refine (#4931)", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  const HOME = "src/lib/date-only-schema.ts";

  /**
   * The files allowed to refine with `isDateOnlyString` themselves, each with
   * its reason. Shrinks only; a new entry needs a reason a reviewer accepts.
   */
  const ALLOWED: Record<string, string> = {
    [HOME]: "the one home of the request-side date-only schemas",
    "src/lib/booking-guest-stay-range-input.ts":
      "a guest's chosen nights are refused in member words, GUEST_NIGHT_INVALID_MESSAGE (#4088)",
  };

  // `.refine(isDateOnlyString` and the arrow spelling `.refine((v) => isDateOnlyString(v)`.
  const REFINE = /\.refine\(\s*(?:isDateOnlyString\b|\(?\s*\w+\s*\)?\s*=>\s*isDateOnlyString\s*\()/g;
  const MESSAGE = /["'`]Date must be YYYY-MM-DD["'`]/g;

  // Every non-test source file under `src/`, by walk rather than by name, so a
  // new route is in the population the moment it exists (`INV-SSOT-004`).
  const sourceFiles = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    return found.sort();
  };

  // Comments are stripped: the house style quotes a removed spelling at the
  // site it was removed from, which a raw-source scan would report (`INV-SSOT-004`).
  const sites = (pattern: RegExp) =>
    sourceFiles().flatMap((file) => {
      const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
      return Array.from(code.matchAll(pattern), () => file);
    });

  it("finds the home's own refine, so the scan is not blind", () => {
    expect(sites(REFINE).filter((file) => file === HOME)).toEqual([HOME]);
  });

  it("finds no refine with isDateOnlyString outside the allowed files", () => {
    expect(sites(REFINE).filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it("finds every allowed file still refining, so a stale entry is removed", () => {
    expect([...new Set(sites(REFINE))].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("writes the message once", () => {
    expect(sites(MESSAGE)).toEqual([HOME]);
  });
});

describe("census: no hand-written date-only pattern outside the allowed files (ALP-580)", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  const SHAPE_HOME = "src/lib/club-time/calendar-date.ts";

  /**
   * The files allowed to spell `/^\d{4}-\d{2}-\d{2}$/` outside a `.regex(` call,
   * each with its reason. That pattern is a SHAPE check: it accepts `2026-02-30`.
   * A real calendar day is `dateOnlyStringSchema` for a request field, or
   * `isCalendarDate` from `@/lib/club-time` (what `isDateOnlyString` delegates
   * to) for a bare check. Shrinks only; a new entry needs a reason a reviewer
   * accepts.
   *
   * The `.regex(` spelling is not counted here; ALP-574's census owns it.
   */
  const ALLOWED: Record<string, string> = {
    [SHAPE_HOME]: "the home of the shape check behind isCalendarDate, which isDateOnlyString delegates to",
    "src/app/api/applications/route.ts":
      "calendarDayOfBirth, its own validator: tells an applicant a mistyped shape from a non-existent day",
    "src/app/api/display/state/route.ts": "already pairs the shape with isDateOnlyString",
    "src/lib/config-transfer/values.ts":
      "strictDate pairs the shape with a real-day check, to tell an importer which of the two a cell fails",
    "src/lib/diagnostics/page-context/projections.ts":
      "one shape in a closed vocabulary of values safe to travel unredacted, not a date validator",
    "src/app/(admin)/admin/finance/payments/_applied-query-vocabulary.ts":
      "mirrors admin-payments-service's regex dateSchema; ALP-574 (#5089) moves both onto isDateOnlyString, and the entry goes with it",
  };

  // The literal, unless it is the argument of `.regex(`.
  const HAND_PATTERN = /(?<!\.regex\(\s*)\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//g;

  const sourceFiles = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    return found.sort();
  };

  const sites = () =>
    sourceFiles().flatMap((file) => {
      const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
      return Array.from(code.matchAll(HAND_PATTERN), () => file);
    });

  it("finds the shape home's own pattern, so the scan is not blind", () => {
    expect(sites().filter((file) => file === SHAPE_HOME)).toEqual([SHAPE_HOME]);
  });

  it("counts both spellings it refuses and skips the one ALP-574 owns", () => {
    const count = (code: string) => Array.from(code.matchAll(HAND_PATTERN)).length;
    expect(count("const P = /^\\d{4}-\\d{2}-\\d{2}$/;")).toBe(1);
    expect(count("if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) return;")).toBe(1);
    expect(count("z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/)")).toBe(0);
    expect(count("z\n  .string()\n  .regex(\n    /^\\d{4}-\\d{2}-\\d{2}$/,\n  )")).toBe(0);
  });

  it("finds no hand-written pattern outside the allowed files", () => {
    expect(sites().filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it("finds every allowed file still spelling it, so a stale entry is removed", () => {
    expect([...new Set(sites())].sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
