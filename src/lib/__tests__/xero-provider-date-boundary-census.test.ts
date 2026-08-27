import { readFileSync, readdirSync, existsSync } from "node:fs";
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
 *
 * ## WHAT THE FIRST VERSION OF THIS CENSUS MISSED, and why each hole is now shut
 *
 * A review ran the first version's own stripper and regex over deliberately
 * mutated copies of this tree, and FOUR OF FIVE MUTANTS WALKED THROUGH. Every
 * one of them is a real spelling that exists, or existed, in this repository:
 *
 * - **`?.[0]?.date`.** The property-chain regex could not match an optional
 *   INDEX followed by an optional property, and `xero-inbound/contact.ts` is
 *   written exactly that way — so a regression on the very line the census was
 *   written to protect was invisible. The chain shape is gone: an access is now
 *   recognised by the FIELD, however the caller reached it.
 * - **A wrapped call.** The scan was per LINE, so Prettier splitting
 *   `new Date(\n  invoice.dueDate,\n)` across three of them defeated it. There
 *   are eight such wraps in this tree already. The scan now works on the whole
 *   file and takes each call's balanced argument text.
 * - **`updatedDateUTCString`.** `updatedDateUTC\b` excludes it, and it is the
 *   field that actually arrives as offset-less TEXT. Both spellings are listed.
 * - **`Date.parse(...)`, `new Date(String(...))`, and an intermediate
 *   variable.** Only the literal `new Date` was banned, so three ways of
 *   spelling the same defect passed. All three are covered: both constructors
 *   are matched, the argument is searched rather than anchored, and a local
 *   bound to a temporal field taints that local.
 * - **The path glob.** `/xero|finance-sync/i` misses
 *   `membership-cancellation-invoice-blockers.ts` — the only non-test module
 *   importing `xero-node` that it does not match — plus
 *   `finance-monthly-fact-backfill.ts` and the report snapshot readers. The
 *   file set is now the union of four rules, and the distinctive field names are
 *   scanned across the WHOLE of `src/` regardless.
 *
 * ## The limits, stated rather than left to be discovered
 *
 * - Taint is one hop and file-local: `const a = invoice.date; const b = a;
 *   new Date(b)` is not caught. It is a scanner, not a type checker.
 * - `date` and `dueDate` are ordinary English words, so they are scanned only
 *   inside the provider file set. The seven Xero-distinctive names are scanned
 *   everywhere.
 * - A defect written entirely through `unknown`, with no field name anywhere
 *   near the call, is invisible to any text rule. The boundary module's own
 *   unit tests are what cover the semantics; this covers the spelling.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The module that IS the boundary, and therefore the one place that parses. */
const BOUNDARY_MODULE = "src/lib/xero-provider-dates.ts";

/**
 * Xero payload fields whose NAME is distinctive enough to scan the whole of
 * `src/` for. Read off the vendored `xero-node` models plus the webhook
 * envelope: `updatedDateUTC` is typed `Date` and documented as a UTC timestamp,
 * `updatedDateUTCString` is its offset-less text twin, `eventDateUtc` is the
 * webhook envelope's own offset-less UTC timestamp, and the rest are typed
 * `string` and documented as dates.
 *
 * Longest first, because a regex alternation is ordered and
 * `updatedDateUTC` would otherwise shadow `updatedDateUTCString`.
 */
const XERO_DISTINCTIVE_TEMPORAL_FIELDS = [
  "updatedDateUTCString",
  "expectedPaymentDate",
  "plannedPaymentDate",
  "endOfYearLockDate",
  "fullyPaidOnDate",
  "periodLockDate",
  "updatedDateUTC",
  "eventDateUtc",
] as const;

/**
 * Xero payload fields whose name is an ordinary English word. Scanned only
 * inside the provider file set, because `new Date(row.date)` in an unrelated
 * module is not necessarily a provider payload.
 */
const XERO_GENERIC_TEMPORAL_FIELDS = ["dueDate", "date"] as const;

/**
 * Files the four membership rules below do not reach but that read provider
 * report payloads all the same. Each is checked to still exist, so a rename
 * fails here instead of silently shrinking the census.
 */
const ADDITIONAL_SCANNED_FILES = [
  // Reads a Xero report payload's fields, including `reportDate`.
  "src/lib/finance-pnl-snapshot.ts",
  "src/lib/finance-cash-snapshot.ts",
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

// ---------------------------------------------------------------------------
// Reading code without reading prose
// ---------------------------------------------------------------------------

interface ScanResult {
  readonly code: string;
  readonly next: number;
}

/**
 * A template literal, from its opening backtick.
 *
 * The literal TEXT is blanked like any other string, but a `${ … }`
 * interpolation is CODE and is kept — a `new Date(invoice.date)` inside one is
 * exactly as much of a defect as anywhere else. Newlines are preserved so a
 * reported line number still points at the right line.
 */
function scanTemplateLiteral(source: string, start: number): ScanResult {
  let out = '""';
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      out += "\n";
      index += 1;
      continue;
    }
    if (char === "`") {
      return { code: out, next: index + 1 };
    }
    if (char === "$" && source[index + 1] === "{") {
      const inner = scanCode(source, index + 2, true);
      out += ` ${inner.code} `;
      index = inner.next;
      continue;
    }
    index += 1;
  }
  return { code: out, next: index };
}

/** The last character of `code` that is not whitespace, or `""`. */
function lastSignificant(code: string): string {
  for (let index = code.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(code[index])) return code[index];
  }
  return "";
}

/** Tokens after which a `/` opens a REGEX rather than dividing. */
const REGEX_POSITION_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|do|else|void|delete|new|yield|await)\s*$/;

/**
 * Does a `/` at this point open a regex literal?
 *
 * THIS IS NOT PEDANTRY, IT IS A MEASURED DEFECT (#2869 review).
 * `xero-contacts.ts` writes `.replace(/"/g, "")` inside a template
 * interpolation. Treating that `"` as a string opener desynchronised the
 * scanner for the remaining thousand lines of the file, so every docblock after
 * it was emitted as CODE — and the census then reported its own explanation of
 * the original defect AS the defect. The previous version of this file claimed
 * "nothing on the scanned surface writes a regex containing a quote", which was
 * untrue when it was written.
 *
 * The rule is the ordinary one: a `/` divides when it follows a value, and
 * opens a regex otherwise. `//` and comment openers are handled before this is
 * reached, and an empty regex is unwritable in JavaScript, so the two cannot
 * collide.
 */
function startsRegexLiteral(codeSoFar: string): boolean {
  const previous = lastSignificant(codeSoFar);
  if (previous === "") return true;
  if (/[)\]\w$]/.test(previous)) {
    return REGEX_POSITION_KEYWORD.test(codeSoFar);
  }
  return true;
}

/** The index just past a regex literal that starts at `start`. */
function endOfRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    // A regex literal cannot span lines; if one appears to, the `/` was
    // division after all and giving up here is the containing answer.
    if (char === "\n") return index;
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

/**
 * What a string literal becomes once blanked — usually `""`, but the KEY of a
 * bracket access is kept.
 *
 * `invoice["dueDate"]` is a property read spelled with a string, and blanking it
 * would make that spelling invisible to every rule below. An identifier-shaped
 * key inside brackets cannot be prose, so keeping it cannot resurrect the #2813
 * class this stripper exists to prevent.
 */
function keptBracketKey(codeSoFar: string, content: string): string {
  if (lastSignificant(codeSoFar) !== "[") return '""';
  return /^[A-Za-z_$][\w$]*$/.test(content) ? `"${content}"` : '""';
}

/**
 * Code, from `start`, with every comment and string literal replaced by
 * something inert of the same LINE COUNT.
 *
 * `stopAtCloseBrace` is for a template interpolation: it returns at the `}`
 * that closes the interpolation rather than at the end of the source, counting
 * nested braces on the way so an object literal inside one does not end it
 * early.
 */
function scanCode(
  source: string,
  start: number,
  stopAtCloseBrace: boolean,
): ScanResult {
  let out = "";
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep the newlines, so a line number after a docblock is still right.
      for (const char of source.slice(index, stop)) {
        if (char === "\n") out += "\n";
      }
      index = stop;
      continue;
    }
    const char = source[index];
    if (char === "`") {
      const template = scanTemplateLiteral(source, index);
      out += template.code;
      index = template.next;
      continue;
    }
    if (char === "/" && startsRegexLiteral(out)) {
      index = endOfRegexLiteral(source, index);
      out += '""';
      continue;
    }
    if (char === '"' || char === "'") {
      const opened = index;
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
      out += keptBracketKey(out, source.slice(opened + 1, index - 1));
      continue;
    }
    if (stopAtCloseBrace) {
      if (char === "{") depth += 1;
      else if (char === "}") {
        if (depth === 0) return { code: out, next: index + 1 };
        depth -= 1;
      }
    }
    out += char;
    index += 1;
  }
  return { code: out, next: index };
}

/**
 * Remove `//` and block comments and the contents of every string, so a rule
 * cannot fire on prose that describes it.
 *
 * Comments, quoted strings, template literals (whose `${…}` interpolations are
 * kept, because those are code) and REGEX LITERALS are all recognised, and the
 * line count is preserved so a reported line number still points at the right
 * line. Regex literals are recognised because one of them broke this — see
 * {@link startsRegexLiteral}.
 */
export function stripCommentsAndStrings(source: string): string {
  return scanCode(source, 0, false).code;
}

// ---------------------------------------------------------------------------
// Finding a banned parse, however it is spelled
// ---------------------------------------------------------------------------

/** `new Date(` and `Date.parse(`, with any whitespace anybody's formatter uses. */
const DATE_CONSTRUCTORS = /\bnew\s+Date\s*\(|\bDate\s*\.\s*parse\s*\(/g;

/**
 * A read of one of `fields`, however the caller reached it: `.date`, `?.date`,
 * `["date"]`. The chain in front is deliberately not described at all — that is
 * the assumption that let `response.body.invoices?.[0]?.date` through.
 */
function fieldAccessPattern(fields: readonly string[]): RegExp {
  const alternatives = fields.join("|");
  return new RegExp(
    String.raw`(?:\?\.|\.)\s*(?:${alternatives})\b|\[\s*(["'])(?:${alternatives})\1\s*\]`,
  );
}

/**
 * The boundary's own readers, plus the kernel parsers they hand off to. A local
 * initialised through one of these holds a CLASSIFIED value, not a raw payload
 * field, so it is not tainted.
 */
const BOUNDARY_READER =
  /\b(?:xeroCalendarDateAsDateOnly|xeroCalendarDateText|xeroCalendarDate|xeroInstant|classifyXeroWireTemporal|parseCalendarDate|requireCalendarDate|dateOnlyInstantOf|parseOptionalDateOnly|toOptionalDateOnlyText|toOptionalReportDateText|toOptionalDate)\s*\(/;

/** `const x = …`, `let x: T = …`, capped so a missing `;` cannot run away. */
const BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]{0,120})?=\s*([^;]{0,500})/g;
/** `const { date, dueDate: due } = invoice;` */
const DESTRUCTURING = /\b(?:const|let|var)\s*\{([^}]{0,500})\}\s*=/g;

/**
 * Locals in this file that hold a Xero temporal field's value.
 *
 * One hop, file-local, and that is stated in the module doc as a limit rather
 * than hidden. It exists because `const raw = invoice.dueDate; new Date(raw);`
 * is the same defect as writing it on one line, and the first version of this
 * census could not see it.
 */
function taintedLocals(code: string, fields: readonly string[]): Set<string> {
  const tainted = new Set<string>();
  const access = fieldAccessPattern(fields);

  for (const match of code.matchAll(BINDING)) {
    if (!access.test(match[2])) continue;
    // A field that has been THROUGH the boundary is no longer a raw provider
    // value, and the whole rule is about raw ones. Without this, the correct
    // spelling — `const day = xeroCalendarDate(invoice.date)` and then a
    // conversion — would be reported as the defect it is the fix for.
    if (BOUNDARY_READER.test(match[2])) continue;
    tainted.add(match[1]);
  }

  for (const match of code.matchAll(DESTRUCTURING)) {
    for (const part of match[1].split(",")) {
      const [key, alias] = part.split(":").map((piece) => piece.trim());
      if (!fields.includes(key)) continue;
      const local = alias && /^[A-Za-z_$][\w$]*$/.test(alias) ? alias : key;
      tainted.add(local);
    }
  }

  return tainted;
}

/** The text between a call's `(` and its matching `)`. */
function balancedArgument(code: string, openParenIndex: number): string {
  let depth = 0;
  for (let index = openParenIndex; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(openParenIndex + 1, index);
    }
  }
  return code.slice(openParenIndex + 1);
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (code[i] === "\n") line += 1;
  return line;
}

/**
 * Every `new Date(…)` / `Date.parse(…)` in `code` whose argument reads one of
 * `fields`, directly or through a local bound to one. Returns `line:snippet`.
 */
function bannedProviderDateParses(
  code: string,
  fields: readonly string[],
): string[] {
  const access = fieldAccessPattern(fields);
  const tainted = taintedLocals(code, fields);
  const taintedPattern =
    tainted.size === 0
      ? null
      : new RegExp(String.raw`\b(?:${[...tainted].join("|")})\b`);

  const found: string[] = [];
  for (const match of code.matchAll(DATE_CONSTRUCTORS)) {
    const openParen = code.indexOf("(", match.index);
    if (openParen === -1) continue;
    const argument = balancedArgument(code, openParen);
    if (!access.test(argument) && !(taintedPattern?.test(argument) ?? false)) {
      continue;
    }
    found.push(
      `${lineOf(code, match.index)}: ${`${match[0]}${argument})`
        .replace(/\s+/g, " ")
        .slice(0, 120)}`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Which files get judged
// ---------------------------------------------------------------------------

interface ScannedFile {
  readonly relativePath: string;
  readonly code: string;
  readonly raw: string;
}

function allSourceFiles(): ScannedFile[] {
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
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      const relativePath = path
        .relative(REPO_ROOT, child)
        .split(path.sep)
        .join("/");
      if (relativePath === BOUNDARY_MODULE) continue;
      const raw = readFileSync(child, "utf8");
      found.push({ relativePath, raw, code: stripCommentsAndStrings(raw) });
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return found.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

const ALL_SOURCE_FILES = allSourceFiles();

/**
 * Every non-test source file that touches the Xero or finance-sync surface.
 *
 * FOUR RULES, UNIONED, because the original single path glob was measured to
 * miss real files:
 *
 * 1. the path names `xero` or `finance-sync` — the partition the epic used to
 *    divide these lanes;
 * 2. the file imports `xero-node` — which is what
 *    `membership-cancellation-invoice-blockers.ts` does, and its path matches
 *    neither word;
 * 3. the file imports a module whose SPECIFIER names either — which is what
 *    `finance-monthly-fact-backfill.ts` does;
 * 4. it is named in {@link ADDITIONAL_SCANNED_FILES}.
 */
function providerFiles(): ScannedFile[] {
  const extras = new Set<string>(ADDITIONAL_SCANNED_FILES);
  return ALL_SOURCE_FILES.filter((file) => {
    if (/xero|finance-sync/i.test(file.relativePath)) return true;
    if (extras.has(file.relativePath)) return true;
    // Against the RAW text, not the stripped code: a module specifier IS a
    // string literal, so the stripper has already blanked it.
    if (/from\s+["']xero-node["']/.test(file.raw)) return true;
    return /from\s+["'][^"']*(?:xero|finance-sync)[^"']*["']/i.test(file.raw);
  });
}

const PROVIDER_FILES = providerFiles();

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

describe("the census can tell code from prose", () => {
  it("removes a line comment", () => {
    expect(stripCommentsAndStrings("a // new Date(invoice.date)\nb")).toBe("a \nb");
  });

  it("removes a block comment but keeps its line count", () => {
    // Line numbers are reported to a human who then opens the file, so a
    // docblock must not shift them. `a  b` was the old answer and was wrong by
    // two lines for everything below it.
    expect(
      stripCommentsAndStrings("a /**\n * new Date(invoice.date)\n */ b"),
    ).toBe("a \n\n b");
  });

  it("empties a string and a template literal", () => {
    expect(stripCommentsAndStrings('f("new Date(x.date)")')).toBe('f("")');
    expect(stripCommentsAndStrings("f(`new Date(x.date)`)")).toBe('f("")');
  });

  it("keeps the CODE inside a template interpolation", () => {
    // `${…}` is code, not prose. Blanking a whole template would hide a real
    // parse written inside one.
    expect(stripCommentsAndStrings("f(`x ${new Date(a.date)} y`)")).toContain(
      "new Date(a.date)",
    );
  });

  it("does not lose its place on a regex literal containing a quote", () => {
    // The exact shape from `xero-contacts.ts`. Before the scanner knew about
    // regex literals, the `"` inside this one opened a phantom string and every
    // docblock in the remaining thousand lines was emitted as code.
    const source = [
      'f(`Email="${m.email.replace(/"/g, "")}"`);',
      "/** new Date(invoice.date) */",
      "const ok = 1;",
    ].join("\n");
    const stripped = stripCommentsAndStrings(source);
    expect(stripped).not.toContain("new Date(invoice.date)");
    expect(stripped).toContain("const ok = 1;");
  });

  it("keeps the code it is meant to judge", () => {
    expect(stripCommentsAndStrings("const d = new Date(invoice.date);")).toContain(
      "new Date(invoice.date)",
    );
  });

  it("finds files to judge, so a broken rule cannot pass vacuously", () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(500);
    expect(PROVIDER_FILES.length).toBeGreaterThan(50);
  });

  it("reaches the files a bare path glob misses", () => {
    const scanned = new Set(PROVIDER_FILES.map((file) => file.relativePath));
    for (const relativePath of [
      // Imports `xero-node`; its path names neither word.
      "src/lib/membership-cancellation-invoice-blockers.ts",
      // Imports the finance-sync datasets; its path names neither word.
      "src/lib/finance-monthly-fact-backfill.ts",
      ...ADDITIONAL_SCANNED_FILES,
    ]) {
      expect(scanned, `${relativePath} is not being scanned`).toContain(
        relativePath,
      );
    }
  });

  it("keeps the extra-file list from outliving its files", () => {
    for (const relativePath of ADDITIONAL_SCANNED_FILES) {
      expect(
        existsSync(path.join(REPO_ROOT, relativePath)),
        `${relativePath} no longer exists; drop it from ADDITIONAL_SCANNED_FILES`,
      ).toBe(true);
    }
  });
});

describe("the census recognises every spelling of the defect", () => {
  // Each of these defeated the FIRST version of this census, measured on
  // mutated copies of this tree. They are pinned as unit tests of the detector
  // so the repair cannot silently regress.
  const spellings: Array<[string, string]> = [
    ["a plain access", "const d = new Date(invoice.date);"],
    ["an optional index then an optional property", "return new Date(r.body.invoices?.[0]?.date);"],
    ["a bracket access", 'const d = new Date(invoice["dueDate"]);'],
    ["a Prettier-wrapped call", "const d = new Date(\n  invoice.dueDate,\n);"],
    ["Date.parse", "const t = Date.parse(invoice.dueDate);"],
    ["a String() wrapper", "const d = new Date(String(invoice.fullyPaidOnDate));"],
    ["an intermediate variable", "const raw = invoice.dueDate;\nconst d = new Date(raw);"],
    ["a destructured field", "const { dueDate } = invoice;\nconst d = new Date(dueDate);"],
    ["updatedDateUTCString, which `updatedDateUTC\\b` excludes", "const d = new Date(c.updatedDateUTCString);"],
    ["the webhook envelope's own field", "const d = new Date(event.eventDateUtc);"],
  ];

  it.each(spellings)("catches %s", (_label, source) => {
    expect(
      bannedProviderDateParses(stripCommentsAndStrings(source), [
        ...XERO_DISTINCTIVE_TEMPORAL_FIELDS,
        ...XERO_GENERIC_TEMPORAL_FIELDS,
      ]),
    ).not.toEqual([]);
  });

  it.each([
    ["a comment describing the defect", "// new Date(invoice.date)\nconst d = 1;"],
    ["a string describing the defect", 'log("new Date(invoice.date)");'],
    ["a field whose name merely ends in Date", "const d = new Date(snapshot.asOfDate);"],
    ["the boundary's own conversion", "const d = dateOnlyInstantOf(xeroCalendarDate(invoice.date));"],
  ])("does not fire on %s", (_label, source) => {
    expect(
      bannedProviderDateParses(stripCommentsAndStrings(source), [
        ...XERO_DISTINCTIVE_TEMPORAL_FIELDS,
        ...XERO_GENERIC_TEMPORAL_FIELDS,
      ]),
    ).toEqual([]);
  });
});

const RULE_ONE_MESSAGE =
  "A Xero payload date must be read through `@/lib/xero-provider-dates` " +
  "(xeroCalendarDate / xeroCalendarDateAsDateOnly / xeroInstant), never by " +
  "`new Date(...)` or `Date.parse(...)`. The SDK types these fields as " +
  "`string` and returns a `Date` for a Microsoft-JSON payload, and an " +
  "offset-less value resolves in the CONTAINER's zone (CT-5, #2869; " +
  "INV-DATE-019).\n";

describe("rule 1: a Xero payload date is classified at the boundary", () => {
  it("is never parsed in place, anywhere in src/, for a Xero-distinctive field", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCE_FILES) {
      for (const hit of bannedProviderDateParses(
        file.code,
        XERO_DISTINCTIVE_TEMPORAL_FIELDS,
      )) {
        offenders.push(`${file.relativePath}:${hit}`);
      }
    }
    expect(offenders, RULE_ONE_MESSAGE + offenders.join("\n")).toEqual([]);
  });

  it("is never parsed in place on the provider surface, for `date` and `dueDate`", () => {
    const offenders: string[] = [];
    for (const file of PROVIDER_FILES) {
      for (const hit of bannedProviderDateParses(
        file.code,
        XERO_GENERIC_TEMPORAL_FIELDS,
      )) {
        offenders.push(`${file.relativePath}:${hit}`);
      }
    }
    expect(offenders, RULE_ONE_MESSAGE + offenders.join("\n")).toEqual([]);
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

  it("names no club's own zone abbreviation in a scheduled-job log line", () => {
    // `INV-CONFIG-001`: this repository is the generic product. Forty
    // "02:20 NZT/NZDT daily" strings were removed from `admin-cron-health.ts`
    // and nineteen more were left one file away in the boot hook, where a
    // London club's deploy log asserted every job ran "AM NZST" (#2869 review).
    for (const relativePath of SCHEDULED_JOB_MODULES) {
      const code = stripCommentsAndStrings(
        readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
      );
      // Template literals keep their interpolations and blank their text, so a
      // `${cronTimeZone()}` line survives and a hard-coded abbreviation does
      // not — which is exactly the distinction being enforced.
      expect(
        /\b(?:NZST|NZDT|NZT)\b/.test(code),
        `${relativePath} hard-codes a New Zealand timezone abbreviation. ` +
          "This repository is the generic product; name the resolved club zone " +
          "instead (INV-CONFIG-001).",
      ).toBe(false);
    }
  });
});

describe("rule 3: an outbound Xero document date is derived at the boundary", () => {
  it("never derives one from the environment's zone", () => {
    const offenders = PROVIDER_FILES.filter((file) =>
      file.code.includes("formatDateOnlyForTimeZone"),
    ).map((file) => file.relativePath);

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
