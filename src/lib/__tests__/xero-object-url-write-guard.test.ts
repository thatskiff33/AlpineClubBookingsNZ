import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { blankLiterals } from "./support/strip-comments";

// #2314: `XeroObjectLink.xeroObjectUrl` and `XeroSyncOperation.xeroObjectUrl`
// are stored ORGANISATION-AGNOSTIC. A short code baked into a row is wrong the
// moment the club reconnects to a different Xero organisation, and nothing
// would ever correct it, so the organisation is applied when the row is READ
// (`applyXeroOrgShortCode`) and stripped when it is written
// (`stripXeroOrgShortCode`).
//
// The two write funnels in `xero-sync.ts` (`upsertXeroObjectLink`,
// `completeXeroSyncOperation`) carry ~50 of the call sites that build one of
// these URLs, so those callers genuinely do not have to remember the rule. But
// four production writers cannot use a funnel — a first-writer-wins claim
// insert, two link upserts inside somebody else's transaction, and the bulk
// historical backfill — and before this guard existed nothing stopped a fifth
// from appearing, or stopped one of the four from starting to pass
// `{ shortCode }` on the reasonable belief that "the column is protected".
// That is what this guard makes true rather than merely documented: every
// DIRECT Prisma write of `xeroObjectUrl` must pass the value through
// `stripXeroOrgShortCode`.
//
// Scope and method (deliberate):
// - `src/` only, test files and `__tests__` excluded — a literal in a test
//   cannot write a production row.
// - It finds `<anything>.xeroObjectLink.<write>(…)` / `.xeroSyncOperation.<write>(…)`
//   calls, reads the balanced argument text with strings and comments masked,
//   and inspects every `xeroObjectUrl` key in that payload.
// - A value counts as protected when it is a direct `stripXeroOrgShortCode(…)`
//   call, an identifier the same file binds to one (`const url =
//   stripXeroOrgShortCode(…)`, which covers the funnels' own shorthand), or a
//   bare `null`. `true`/`false` are `select`/`omit` flags, not writes.
// - The set of FILES holding such a writer is pinned below, so a fifth writer
//   in a new file is a deliberate, reviewed addition rather than a silent one.
//
// What this guard CANNOT catch, stated plainly so nobody reads a green run as
// more than it is: a payload assembled somewhere else and handed to the write
// as an opaque identifier (`data: rows`) — which is why the backfill maps its
// rows through the strip AT the `createMany` rather than in its row builder,
// and why {@link OPAQUE_PAYLOAD_WRITES} is pinned too; a write through raw SQL
// (there is none today); and a column set by a Prisma extension. It is a
// mechanism for the shape the code actually takes, not a proof.

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/;

/** Prisma write methods that can carry a payload for these two models. */
const WRITE_CALL =
  /\.\s*(xeroObjectLink|xeroSyncOperation)\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g;

/** The strip helper, spelled once. */
const STRIP = "stripXeroOrgShortCode(";

/**
 * Every file with a DIRECT Prisma write that sets `xeroObjectUrl`.
 *
 * `xero-sync.ts` holds the two funnels. The other three cannot use them:
 * `membership-cancellation-xero.ts` needs `INSERT … ON CONFLICT DO NOTHING`
 * for a first-writer-wins claim, `xero-subscription-invoices.ts` writes inside
 * a transaction whose shape the funnel would change, and
 * `xero-hardening-backfill.ts` reconstructs historical rows in bulk.
 *
 * `xero-contact-create-recovery.ts` is the fifth (#2623 T7): closing a
 * provider-created create whose contact has since been linked is a
 * STATUS-GUARDED claim (`updateMany` on `status: "FAILED", manuallyResolvedAt:
 * null`), so a lost race writes nothing. `completeXeroSyncOperation` is an
 * unguarded `update` by id and would defeat that, so this writer strips the
 * short code itself.
 */
const KNOWN_URL_WRITER_FILES = [
  "src/lib/membership-cancellation-xero.ts",
  "src/lib/xero-contact-create-recovery.ts",
  "src/lib/xero-hardening-backfill.ts",
  "src/lib/xero-subscription-invoices.ts",
  "src/lib/xero-sync.ts",
];

/**
 * Direct writes whose payload is an opaque identifier rather than an inline
 * object/array literal, so the guard cannot read what they set.
 *
 * Empty on purpose: the one that used to be here (the backfill's
 * `xeroSyncOperation.createMany({ data: operationsToCreate })`) now maps its
 * rows through `stripXeroOrgShortCode` at the write. Keeping the list at zero
 * is what stops the guard being routed around by moving a payload one function
 * away; adding an entry has to be argued for in review.
 */
const OPAQUE_PAYLOAD_WRITES: string[] = [];

function collectSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      collectSourceFiles(full, out);
    } else if (
      SOURCE_EXTENSIONS.test(entry.name) &&
      !TEST_FILE.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The balanced `(...)` argument text starting at the `(` at `openIndex`. */
function readCallArguments(masked: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return masked.slice(openIndex + 1, i);
    }
  }
  return masked.slice(openIndex + 1);
}

interface PropertyValue {
  /** The value expression, or null for `{ xeroObjectUrl }` shorthand. */
  value: string | null;
}

/** Every `key: value` (or `{ key }` shorthand) for `key` inside `payload`. */
function readPropertyValues(payload: string, key: string): PropertyValue[] {
  const found: PropertyValue[] = [];
  let from = 0;
  while (from < payload.length) {
    const at = payload.indexOf(key, from);
    if (at < 0) break;
    from = at + key.length;

    const before = payload.slice(0, at).trimEnd().slice(-1);
    const isKeyPosition = before === "" || before === "{" || before === ",";
    const afterText = payload.slice(from);
    const after = afterText.trimStart().slice(0, 1);
    // `operation.xeroObjectUrl` and `xeroObjectUrlSomething` are not keys.
    if (!isKeyPosition || /^[\w$]/.test(afterText)) continue;

    if (after === ":") {
      const valueStart = from + afterText.indexOf(":") + 1;
      let depth = 0;
      let end = payload.length;
      for (let i = valueStart; i < payload.length; i += 1) {
        const ch = payload[i];
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]") depth -= 1;
        else if (ch === "}") {
          if (depth === 0) {
            end = i;
            break;
          }
          depth -= 1;
        } else if (ch === "," && depth === 0) {
          end = i;
          break;
        }
      }
      found.push({ value: payload.slice(valueStart, end).trim() });
      from = end;
    } else if (after === "," || after === "}" || after === "") {
      found.push({ value: null });
    }
  }
  return found;
}

/** True when this value can only ever reach the column organisation-agnostic. */
function isProtected(value: string | null, fileSource: string): boolean {
  const identifier = value === null ? "xeroObjectUrl" : value;
  if (value !== null) {
    if (value.startsWith(STRIP)) return true;
    // `select: { xeroObjectUrl: true }` / `omit` flags are reads, not writes.
    if (value === "true" || value === "false") return true;
    // An explicit null names no organisation.
    if (value === "null") return true;
    if (!/^[A-Za-z_$][\w$]*$/.test(value)) return false;
  }
  return new RegExp(
    `\\b(?:const|let|var)\\s+${identifier}\\s*(?::[^=]+)?=\\s*${STRIP.replace("(", "\\(")}`,
  ).test(fileSource);
}

interface WriteSite {
  file: string;
  line: number;
  model: string;
  method: string;
  payload: string;
}

/**
 * Every direct Prisma write to the two models in one file's source.
 *
 * It reads a BLANKED copy: the same text with every comment and every literal's
 * CONTENTS replaced by spaces, so brace and paren depth and the property scan
 * cannot be confused by a `{` in a comment or a `,` inside a URL. Length and
 * offsets are preserved, which is what lets the line number below be a real
 * line number and `readCallArguments` slice by index.
 *
 * ONE DEFINITION, SHARED (#3180, `INV-SSOT-004`). This file wrote its own until
 * then, as did `lock-bound-club-zone-outside-transaction.test.ts` and
 * `payment-link-expiry-club-zone.test.ts`, and none of the three recognised a
 * REGEX LITERAL — the defect #3155 removed from the shared scanner, where
 * `.replace(/\//g, "_")` reads as a line comment and the rest of the line
 * disappears. The delimiters survive and only the contents are blanked, so
 * `{ xeroObjectUrl: "https://x" }` still reads as a key with a string value
 * rather than as a key with a hole where its value was.
 */
function findWriteSites(relPath: string, source: string): WriteSite[] {
  const masked = blankLiterals(source);
  const sites: WriteSite[] = [];
  WRITE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WRITE_CALL.exec(masked)) !== null) {
    const openIndex = match.index + match[0].length - 1;
    sites.push({
      file: relPath,
      line: masked.slice(0, match.index).split("\n").length,
      model: match[1],
      method: match[2],
      payload: readCallArguments(masked, openIndex),
    });
  }
  return sites;
}

function loadWriteSites(): { sites: WriteSite[]; sources: Map<string, string> } {
  const root = process.cwd();
  const sites: WriteSite[] = [];
  const sources = new Map<string, string>();
  for (const file of collectSourceFiles(join(root, "src"), [])) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("xeroObjectLink") && !source.includes("xeroSyncOperation")) {
      continue;
    }
    const relPath = relative(root, file).replace(/\\/g, "/");
    sources.set(relPath, source);
    sites.push(...findWriteSites(relPath, source));
  }
  return { sites, sources };
}

describe("xeroObjectUrl write guard (#2314)", () => {
  const { sites, sources } = loadWriteSites();

  it("strips the organisation at every direct write of the column", () => {
    const offenders: string[] = [];

    for (const site of sites) {
      const source = sources.get(site.file) ?? "";
      for (const property of readPropertyValues(site.payload, "xeroObjectUrl")) {
        if (isProtected(property.value, source)) continue;
        offenders.push(
          `${site.file}:${site.line} (${site.model}.${site.method}) ` +
            `xeroObjectUrl: ${property.value ?? "<shorthand>"}`,
        );
      }
    }

    expect(
      offenders,
      `Direct Prisma write(s) of xeroObjectUrl that do not strip the Xero ` +
        `organisation. Both columns are stored organisation-AGNOSTIC (#2314): a ` +
        `short code baked into a row is wrong the moment the club reconnects to ` +
        `a different Xero organisation, and nothing corrects it — the ` +
        `organisation is applied on READ by applyXeroOrgShortCode instead. ` +
        `Either write through upsertXeroObjectLink / completeXeroSyncOperation, ` +
        `or wrap the value in stripXeroOrgShortCode(...) at the write.\n\n` +
        `${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the set of direct writers pinned", () => {
    const writerFiles = [
      ...new Set(
        sites
          .filter(
            (site) => readPropertyValues(site.payload, "xeroObjectUrl").length > 0,
          )
          .map((site) => site.file),
      ),
    ].sort();

    expect(
      writerFiles,
      `The list of files writing xeroObjectUrl directly has changed. A new one ` +
        `is fine — it just has to be a decision: confirm it cannot use ` +
        `upsertXeroObjectLink / completeXeroSyncOperation, confirm it strips, ` +
        `and add it to KNOWN_URL_WRITER_FILES with the reason.`,
    ).toEqual(KNOWN_URL_WRITER_FILES);
  });

  it("keeps every write payload readable (no opaque hand-off)", () => {
    const opaque: string[] = [];

    for (const site of sites) {
      for (const key of ["data", "create", "update"]) {
        for (const property of readPropertyValues(site.payload, key)) {
          const value = property.value?.trim() ?? "";
          if (!value || value.startsWith("{") || value.startsWith("[")) continue;
          // An inline `.map(…)` / `.flatMap(…)` still spells its payload here.
          if (/\.(?:map|flatMap)\s*\(/.test(value)) continue;
          opaque.push(`${site.file}:${site.line} ${key}: ${value}`);
        }
      }
    }

    expect(
      opaque,
      `Direct Prisma write(s) to XeroObjectLink / XeroSyncOperation whose ` +
        `payload is built elsewhere, so the guard above cannot see whether ` +
        `xeroObjectUrl is stripped. Build the payload at the write (or map the ` +
        `rows through stripXeroOrgShortCode there) rather than adding to ` +
        `OPAQUE_PAYLOAD_WRITES.`,
    ).toEqual(OPAQUE_PAYLOAD_WRITES);
  });

  // The guard is only as good as its extraction: if the walker or the call
  // regex silently stopped matching, both assertions above would pass on an
  // empty set forever.
  it("actually finds the known writers (extraction canary)", () => {
    expect(sites.length).toBeGreaterThan(20);

    // THE SCANNER MUST NOT GO BLIND AFTER A REGEX LITERAL, and this is pinned
    // against the file that proved it can. `xero-contacts.ts` writes
    // `.replace(/"/g, "")` while building a Xero `where` clause. The private
    // masker this file carried until #3180 had no regex branch, read that
    // quote as a string opener and desynchronised, so this file's
    // `prisma.xeroSyncOperation.update(...)` was INVISIBLE to the census.
    // Measured on the conversion: 58 write sites became 59, and this file went
    // from contributing none to contributing one. The recovered write carries
    // no `xeroObjectUrl` today, so the guard was passing rather than wrong —
    // live but LATENT, one added property from being otherwise. Restoring a
    // regex-blind masker makes this line fail, which is the point of it.
    expect(
      sites.filter((site) => site.file === "src/lib/xero-contacts.ts").length,
      "No write site found in src/lib/xero-contacts.ts. Either that file " +
        "stopped writing XeroSyncOperation directly — in which case delete " +
        "this check and say so — or the masker has gone blind at the regex " +
        "literal in the Xero contact search, which is the #3155 defect and " +
        "the reason this guard shares `blankLiterals` (#3180, INV-SSOT-004).",
    ).toBeGreaterThan(0);
    for (const file of KNOWN_URL_WRITER_FILES) {
      const urlWrites = sites.filter(
        (site) =>
          site.file === file &&
          readPropertyValues(site.payload, "xeroObjectUrl").length > 0,
      );
      expect(urlWrites.length, `no xeroObjectUrl write found in ${file}`).
        toBeGreaterThan(0);
    }
    // The two funnels, by name, in the file that is meant to hold them.
    const syncSource = sources.get("src/lib/xero-sync.ts") ?? "";
    expect(syncSource).toContain("export async function upsertXeroObjectLink");
    expect(syncSource).toContain("export async function completeXeroSyncOperation");
  });

  // …and the analysis itself, pinned in both directions against source it
  // controls, so a change that makes the guard blind fails here rather than
  // going green over a real bypass.
  it("accepts protected writes and rejects unprotected ones (analysis canary)", () => {
    const cases: Array<[string, boolean]> = [
      [
        `await prisma.xeroObjectLink.createMany({ data: [{ xeroObjectUrl: buildXeroInvoiceUrl(id) }] });`,
        false,
      ],
      [
        `await tx.xeroObjectLink.upsert({ update: { xeroObjectUrl: buildXeroInvoiceUrl(id, { shortCode }) } });`,
        false,
      ],
      [
        `await prisma.xeroSyncOperation.update({ data: { xeroObjectUrl: row.xeroObjectUrl } });`,
        false,
      ],
      [
        `await prisma.xeroObjectLink.createMany({ data: [{ xeroObjectUrl: stripXeroOrgShortCode(buildXeroInvoiceUrl(id)) }] });`,
        true,
      ],
      [
        `const link = stripXeroOrgShortCode(buildXeroInvoiceUrl(id));\n` +
          `await tx.xeroObjectLink.upsert({ create: { xeroObjectUrl: link }, update: { xeroObjectUrl: link } });`,
        true,
      ],
      [
        `const xeroObjectUrl = stripXeroOrgShortCode(input.url);\n` +
          `await tx.xeroSyncOperation.update({ data: { xeroObjectUrl, completedAt } });`,
        true,
      ],
      [
        `await prisma.xeroObjectLink.updateMany({ data: { active: false }, select: { xeroObjectUrl: true } });`,
        true,
      ],
      // A REGEX LITERAL ON THE WRITE'S OWN LINE. A masker without a regex
      // branch — which all three private copies were until #3180 — reads the
      // two adjacent slashes as a line comment and blanks the rest of the
      // line, so the write vanishes and this census reports nothing about
      // it. That is the #3155 defect, it is what hid a real
      // `xeroSyncOperation.update` in `xero-contacts.ts` from this guard
      // until now, and one line is what makes the case bite: split across
      // two, the damage stays on the first and the guard passes either way.
      [
        `const slug = raw.replace(/\\//g, \"_\"); await prisma.xeroSyncOperation.update({ data: { xeroObjectUrl: row.xeroObjectUrl } });`,
        false,
      ],
      // A comment or a string mentioning the column must not be mistaken for a
      // write, in either direction.
      [
        `await prisma.xeroObjectLink.updateMany({ /* xeroObjectUrl: buildXeroInvoiceUrl(id) */ data: { active: false } });`,
        true,
      ],
    ];

    for (const [source, shouldPass] of cases) {
      const offenders = findWriteSites("synthetic.ts", source).flatMap((site) =>
        readPropertyValues(site.payload, "xeroObjectUrl").filter(
          (property) => !isProtected(property.value, source),
        ),
      );
      expect(offenders.length === 0, source).toBe(shouldPass);
    }
  });
});

