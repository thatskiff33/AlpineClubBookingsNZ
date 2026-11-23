/**
 * EVERY CREDIT-NOTE LINK LITERAL THAT RECORDS A XERO STATUS, CLASSIFIED (#4288,
 * `INV-ADDPAY-041`).
 *
 * The owner's decision (24 Oct 2026) orders two snapshots of one refund note by
 * Xero's own `UpdatedDateUTC`, stored on the link beside the status
 * (`judgeRefundNoteWrite`). A writer that records a status it read from Xero
 * without that stamp would fall back to "a stored void wins" and lose the
 * ordering between two live readings. So the status and its stamp have one
 * builder, `xeroCreditNoteSnapshotMetadata`, and this reads every non-test
 * source file and:
 *
 * - finds each object literal that names `xeroObjectType: "CREDIT_NOTE"`, a
 *   refund-note `role`, or spreads a link (`...link`), and has a `metadata`
 *   object literal. If that metadata names `status` itself it must be a
 *   declared exception below, with the reason it is not a Xero reading;
 * - enumerates every site whose metadata is, or spreads, the builder, so a
 *   writer that stops using it fails here by name;
 * - fails any other source file that spells the stamp's key itself.
 *
 * `pnpm run test:related` CANNOT SELECT THIS FILE: it has no import edge to the
 * tree it scans. Run it by name with `pnpm run test:named`.
 *
 * ## What it cannot see
 *
 * - Metadata passed by variable or parameter (`metadata: noteLinkMetadata`,
 *   `metadata: params.metadata`, shorthand `metadata`). None carries a status
 *   today: the outbound create's link is status-less, and an inbound status
 *   always comes through the builder at the literal.
 * - A link literal that names its type and role only through variables or
 *   parameters (`xeroObjectType: params.type`, `role: params.role`) and spreads
 *   nothing whose text names a link.
 * - A link built in steps (`link.metadata = ...`) or by `Object.assign`.
 * - A metadata object whose status is spread in from another object
 *   (`metadata: { ...reading }`) rather than named.
 *
 * **Re-measure by running this test. Add an entry only with its reason.**
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { relativeSource, sourceFiles } from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { REFUND_NOTE_SNAPSHOT_AT_KEY } from "@/lib/xero-refund-note-status";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const BUILDER = "xeroCreditNoteSnapshotMetadata";
const BUILDER_HOME = "src/lib/xero-refund-note-status.ts";

/** The writers that record a Xero reading, by file and how many link literals each has. */
const STAMPED_WRITERS: Record<string, number> = {
  // The inbound reconcile: an existing link of any role, the pointer's note,
  // an account-credit payment, and a pointer named only after the first pass.
  "src/lib/xero-inbound/credit-note.ts": 4,
  // The Stripe status recorder (#2901).
  "src/lib/xero-refund-note-status-recorder.ts": 1,
  // The hand-made note answer (#4162), stamped with the reading it checked.
  "src/lib/bank-refund-void-answer.ts": 1,
};

/** Credit-note link literals that name a status that is not a Xero reading, by `file:status expression`. */
const NOT_A_XERO_READING: Record<string, string> = {
  // The #4161 heal re-asserts the status the row already records, read under
  // its own row lock; only a VOIDED/DELETED mirror is healed, and an incoming
  // void is always applied. It carries no new reading to order.
  "src/lib/xero-hardening-canonical-links.ts:asRecord(link.metadata)?.status":
    "re-asserts the row's own stored VOIDED/DELETED status (#4161)",
  // The demo seed's voided note: a fixed VOIDED fixture written directly, never
  // a Xero reading.
  'prisma/demo-seed.ts:"VOIDED"': "a fixed demo fixture",
  // `keepStoredRefundNoteVoid` (review 5): a status-less write keeping the
  // row's own stored VOIDED/DELETED status, read under its lock; the write it
  // returns carries no reading of its own.
  "src/lib/xero-refund-note-status.ts:readRefundCreditNoteLinkStatus(stored?.metadata)":
    "keepStoredRefundNoteVoid keeps the stored void's status (#4223)",
};

type Finding = { file: string; line: number; kind: "builder" | "status"; text: string };

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!property.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return null;
}

function isBuilderCall(node: ts.Expression): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === BUILDER;
}

/** The refund-note roles a link literal can name, as a string or by the request role's constant. */
const REFUND_NOTE_ROLES = new Set(["REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE_ROLE"]);

/**
 * A literal that is, or may be, a credit-note link: it names
 * `xeroObjectType: "CREDIT_NOTE"`, or (review 5) it names a refund-note `role`,
 * or it spreads a link (`...link`, `...normalizedLink`) whose type it cannot see.
 */
function isCreditNoteLinkLiteral(node: ts.ObjectLiteralExpression, type: ts.ObjectLiteralElementLike | undefined, role: ts.ObjectLiteralElementLike | undefined): boolean {
  if (type && ts.isPropertyAssignment(type) && ts.isStringLiteral(type.initializer) && type.initializer.text === "CREDIT_NOTE") return true;
  if (role && ts.isPropertyAssignment(role) && (ts.isStringLiteral(role.initializer) || ts.isIdentifier(role.initializer)) && REFUND_NOTE_ROLES.has(role.initializer.text)) return true;
  return node.properties.some((property) => ts.isSpreadAssignment(property) && /link/i.test(property.expression.getText()));
}

/** The credit-note link literals in one file that name a status, or take it from the builder. */
function scanCode(relative: string, code: string): Finding[] {
  const findings: Finding[] = [];
  const source = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true, relative.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const find = (name: string) => node.properties.find((property) => propertyName(property) === name);
      const type = find("xeroObjectType");
      const metadata = find("metadata");
      if (isCreditNoteLinkLiteral(node, type, find("role")) && metadata && ts.isPropertyAssignment(metadata)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const value = metadata.initializer;
        if (isBuilderCall(value)) {
          findings.push({ file: relative, line, kind: "builder", text: BUILDER });
        } else if (ts.isObjectLiteralExpression(value)) {
          const spreadsBuilder = value.properties.some((property) => ts.isSpreadAssignment(property) && isBuilderCall(property.expression));
          const status = value.properties.find((property) => propertyName(property) === "status");
          if (spreadsBuilder) findings.push({ file: relative, line, kind: "builder", text: BUILDER });
          if (status) {
            const text = ts.isPropertyAssignment(status) ? status.initializer.getText(source) : "status";
            findings.push({ file: relative, line, kind: "status", text });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function scan(): { findings: Finding[]; stampKeyFiles: string[] } {
  const findings: Finding[] = [];
  const stampKeyFiles: string[] = [];
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    const relative = relativeSource(file);
    if (relative !== BUILDER_HOME && code.includes(REFUND_NOTE_SNAPSHOT_AT_KEY)) stampKeyFiles.push(relative);
    if (/"CREDIT_NOTE"|REFUND_|\.\.\.\w*link/i.test(code)) findings.push(...scanCode(relative, code));
  }
  return { findings, stampKeyFiles };
}

const undeclaredStatuses = (findings: Finding[]) =>
  findings
    .filter((finding) => finding.kind === "status" && !NOT_A_XERO_READING[`${finding.file}:${finding.text}`])
    .map((finding) => `${finding.file}:${finding.line} records status ${finding.text} without its UpdatedDateUTC - spread ${BUILDER}(...) instead`);

describe("every credit-note link that records a Xero status stamps its UpdatedDateUTC (#4288, INV-ADDPAY-041)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const { findings, stampKeyFiles } = scan();

  it("names a status only through the one builder; every other named status is declared, with its reason", () => {
    expect(undeclaredStatuses(findings), "INV-ADDPAY-041 (#4288): a refund-note status needs its Xero timestamp").toEqual([]);
    const declared = new Set(findings.filter((finding) => finding.kind === "status").map((finding) => `${finding.file}:${finding.text}`));
    expect(Object.keys(NOT_A_XERO_READING).filter((key) => !declared.has(key)), "a declared exception that no longer exists").toEqual([]);
  });

  it("every writer that records a Xero reading still goes through the builder, by name", () => {
    const counts: Record<string, number> = {};
    for (const finding of findings.filter((entry) => entry.kind === "builder")) counts[finding.file] = (counts[finding.file] ?? 0) + 1;
    expect(counts).toEqual(STAMPED_WRITERS);
  });

  it("no other source file spells the stamp's key itself", () => {
    expect(stampKeyFiles).toEqual([]);
  });

  it("MUTATION: a link literal naming a status without the builder is found; one spreading it is counted", () => {
    const writer = (metadata: string) => `upsertXeroObjectLink({ xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE", metadata: ${metadata}, mergeMetadata: true });`;
    expect(undeclaredStatuses(scanCode("src/lib/probe.ts", writer("{ status: note.status ?? null, total: note.total }")))).toEqual([
      "src/lib/probe.ts:1 records status note.status ?? null without its UpdatedDateUTC - spread xeroCreditNoteSnapshotMetadata(...) instead",
    ]);
    expect(scanCode("src/lib/probe.ts", writer("{ ...xeroCreditNoteSnapshotMetadata(note), amountCents: 1 }"))).toEqual([
      { file: "src/lib/probe.ts", line: 1, kind: "builder", text: BUILDER },
    ]);
  });

  it.each([
    ["a refund-note role and no type", 'upsertXeroObjectLink({ role: "REFUND_CREDIT_NOTE", metadata: { status: note.status } });'],
    ["the request role's constant", "upsertXeroObjectLink({ role: REFUND_REQUEST_CREDIT_NOTE_ROLE, metadata: { status: note.status } });"],
    ["a spread link", "upsertXeroObjectLink({ ...link, metadata: { status: note.status } });"],
    ["a spread normalised link", "return { ...normalizedLink, active: false, metadata: { status: note.status } };"],
  ])("MUTATION (review 5): a status named on %s is found", (_label, code) => {
    expect(undeclaredStatuses(scanCode("src/lib/probe.ts", code))).toEqual([
      "src/lib/probe.ts:1 records status note.status without its UpdatedDateUTC - spread xeroCreditNoteSnapshotMetadata(...) instead",
    ]);
  });

  it("an unrelated literal with a status in its metadata is not a link", () => {
    expect(scanCode("src/lib/probe.ts", 'createAuditLog({ ...base, action: "x", metadata: { status: booking.status } });')).toEqual([]);
  });
});
