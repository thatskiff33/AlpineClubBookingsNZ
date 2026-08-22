import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The provider, job and export temporal boundary, enforced mechanically
 * (CT-5, #2869; epic #2988).
 *
 * THREE RULES, each one a defect this repository has actually shipped.
 *
 * 1. **A Xero payload date is classified at the boundary, never parsed in place.**
 *    `xero-node` TYPES `Invoice.date` as `string` and hands back a `Date` at
 *    runtime for a Microsoft-JSON payload, so `new Date(invoice.date)` was
 *    correct for one wire shape and wrong for another — and for an offset-less
 *    `"2019-03-11T00:00:00"` it resolved in the SERVER's zone and stored
 *    `Member.joinedDate` a day early.
 *
 * 2. **A scheduled job's civil time is the club's, not the container's.**
 *    `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`,
 *    so a deployment moved to another region moved every job with it.
 *
 * 3. **An outbound Xero document date is derived at the boundary.**
 *    `formatDateOnlyForTimeZone(new Date())` reads the ENVIRONMENT's zone; every
 *    Xero document date now goes through `xeroDocumentDate*`, which takes the
 *    persisted club zone explicitly.
 *
 * WHY IT SCANS DISK RATHER THAN IMPORTING. There is no import edge from a rule
 * about spelling to the files it judges, which is also why `vitest related`
 * cannot reach this file: run it explicitly when you change the Xero surface.
 * CI runs it either way.
 *
 * WHY IT STRIPS COMMENTS AND STRINGS FIRST, and this is not tidiness. #2813 went
 * red because a contract regex matched a banned symbol inside a COMMENT. Every
 * rule below is stated in this file's own docblock and in the docblocks of the
 * modules it guards, so a census that matched raw text would fail on its own
 * explanation — and the only way to make it pass would be to stop explaining.
 * `stripCommentsAndStrings` has its own tests below for exactly that reason.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The module that IS the boundary, and therefore the one place that parses. */
const BOUNDARY_MODULE = "src/lib/xero-provider-dates.ts";

/**
 * Every Xero payload field that carries a date or a time. Read off the vendored
 * `xero-node` models: the first six are typed `string` and documented as dates;
 * `updatedDateUTC` is typed `Date` and documented as a UTC timestamp.
 */
const XERO_TEMPORAL_FIELDS = [
  "date",
  "dueDate",
  "expectedPaymentDate",
  "plannedPaymentDate",
  "fullyPaidOnDate",
  "periodLockDate",
  "endOfYearLockDate",
  "updatedDateUTC",
] as const;

/**
 * The modules that decide, or report, WHEN a background job runs. A cron
 * expression is a club-local scheduled time, so none of them may read the
 * environment's zone.
 */
const SCHEDULED_JOB_MODULES = [
  "src/instrumentation.node.ts",
  "src/lib/admin-cron-health.ts",
  "src/lib/finance-sync-cron-config.ts",
  "src/lib/finance-sync-cron.ts",
  "src/lib/finance-sync-diagnostics.ts",
] as const;

/**
 * Remove `//` and block comments and the contents of every string and template
 * literal, so a rule cannot fire on prose that describes it.
 *
 * Deliberately simple: it does not attempt to distinguish a regex literal from
 * a division, because nothing on the scanned surface writes a regex containing
 * a quote or a comment opener. A wrong guess there could only make the census
 * MISS something, and the tests below pin the cases that matter.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          break;
        }
        if (source[index] === "\n") break;
        index += 1;
      }
      out += '""';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

interface ScannedFile {
  readonly relativePath: string;
  readonly code: string;
}

/**
 * Every non-test source file whose PATH names Xero or the finance sync — which
 * is the same partition the epic used to divide these lanes, so the census and
 * the ownership boundary cannot drift apart.
 */
function providerFiles(): ScannedFile[] {
  const found: ScannedFile[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(child);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const relativePath = path
        .relative(REPO_ROOT, child)
        .split(path.sep)
        .join("/");
      if (!/xero|finance-sync/i.test(relativePath)) continue;
      if (relativePath === BOUNDARY_MODULE) continue;
      found.push({
        relativePath,
        code: stripCommentsAndStrings(readFileSync(child, "utf8")),
      });
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return found.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

describe("the census can tell code from prose", () => {
  it("removes a line comment", () => {
    expect(stripCommentsAndStrings("a // new Date(invoice.date)\nb")).toBe("a \nb");
  });

  it("removes a block comment, including a docblock spanning lines", () => {
    expect(
      stripCommentsAndStrings("a /**\n * new Date(invoice.date)\n */ b"),
    ).toBe("a  b");
  });

  it("empties a string and a template literal", () => {
    expect(stripCommentsAndStrings('f("new Date(x.date)")')).toBe('f("")');
    expect(stripCommentsAndStrings("f(`new Date(x.date)`)")).toBe('f("")');
  });

  it("keeps the code it is meant to judge", () => {
    expect(stripCommentsAndStrings("const d = new Date(invoice.date);")).toContain(
      "new Date(invoice.date)",
    );
  });

  it("finds at least one file to judge, so a broken glob cannot pass vacuously", () => {
    expect(providerFiles().length).toBeGreaterThan(50);
  });
});

describe("rule 1: a Xero payload date is classified at the boundary", () => {
  it("is never handed straight to new Date()", () => {
    const fieldAlternatives = XERO_TEMPORAL_FIELDS.join("|");
    const pattern = new RegExp(
      String.raw`new Date\(\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]*\])*\??\.(?:${fieldAlternatives})\b`,
    );
    const offenders: string[] = [];
    for (const file of providerFiles()) {
      for (const [index, line] of file.code.split("\n").entries()) {
        if (pattern.test(line)) {
          offenders.push(`${file.relativePath}:${index + 1}`);
        }
      }
    }

    expect(
      offenders,
      "A Xero payload date must be read through `@/lib/xero-provider-dates` " +
        "(xeroCalendarDate / xeroCalendarDateAsDateOnly / xeroInstant), never by " +
        "`new Date(...)`. The SDK types these fields as `string` and returns a " +
        "`Date` for a Microsoft-JSON payload, and an offset-less value resolves " +
        "in the CONTAINER's zone (CT-5, #2869; INV-DATE-019).\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

describe("rule 2: a scheduled job runs on the club's civil time", () => {
  it.each(SCHEDULED_JOB_MODULES)("%s does not read APP_TIME_ZONE", (relativePath) => {
    const code = stripCommentsAndStrings(
      readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
    );
    expect(
      code.includes("APP_TIME_ZONE"),
      `${relativePath} reads APP_TIME_ZONE, which is the CONTAINER's zone ` +
        "(`process.env.TZ || NEXT_PUBLIC_TZ || \"Pacific/Auckland\"`). A cron " +
        "expression is a club-local scheduled time, so the zone must come from " +
        "the persisted club setting (CT-5, #2869; INV-CONFIG-002).",
    ).toBe(false);
  });

  it("registers every job against the resolved club zone and nothing else", () => {
    const code = stripCommentsAndStrings(
      readFileSync(path.join(REPO_ROOT, "src/instrumentation.node.ts"), "utf8"),
    );
    const values = [...code.matchAll(/timezone:\s*([^,\n}]+)/g)].map((match) =>
      match[1].trim(),
    );

    // Not merely "no bad value": a glob or a rename that stopped matching would
    // make an empty list pass, so the count is pinned as well.
    expect(values.length).toBeGreaterThan(20);
    expect([...new Set(values)]).toEqual(["cronTimeZone()"]);
  });
});

describe("rule 3: an outbound Xero document date is derived at the boundary", () => {
  it("never derives one from the environment's zone", () => {
    const offenders = providerFiles()
      .filter((file) => file.code.includes("formatDateOnlyForTimeZone"))
      .map((file) => file.relativePath);

    expect(
      offenders,
      "`formatDateOnlyForTimeZone` defaults to APP_TIME_ZONE — the container's " +
        "zone. A Xero document date is derived through " +
        "`xeroDocumentDateForClubToday` / `xeroDocumentDateFromInstant` / " +
        "`xeroDocumentDateFromDateOnlyColumn`, which take the persisted club " +
        "zone explicitly (CT-5, #2869).\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
