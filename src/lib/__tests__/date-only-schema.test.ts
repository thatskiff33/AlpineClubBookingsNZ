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
