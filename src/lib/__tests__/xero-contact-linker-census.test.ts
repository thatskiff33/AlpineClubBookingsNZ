/**
 * EVERY LINKER OF A XERO CONTACT ID, MEASURED (#2939, `INV-INT-018`).
 *
 * `INV-INT-018` now says "every linker in the tree, with no exception but
 * `INV-INT-020`". That is a claim about a POPULATION, and until this file it
 * was supported by a hand-written list in the invariant's own prose — which is
 * not a measurement of the population, it is a memory of it. The list had
 * already drifted: it named five paths while the same invariant entry named a
 * sixth two paragraphs further down.
 *
 * So the list is replaced by an instrument. This reads every non-test source
 * file from disk and finds each site that writes `xeroContactId` onto a
 * `Member` or an `Organisation` row — a create, an update, an upsert or an
 * `updateMany`, through the delegate or through a transaction client — and
 * fails when the set of FILES holding them is not exactly the declared one.
 *
 * `npm run test:related` CANNOT SELECT THIS FILE. It has no import edge to the
 * tree it scans, so the module graph cannot reach it from a changed file; that
 * is the blind spot `AGENTS.md` names for every disk-scanning census here. It
 * is CI-caught by design. Run it by name with `npm run test:named`.
 *
 * ## What it can and cannot see
 *
 * It sees a write whose data object names `xeroContactId` at the top level,
 * which is how every linker in this tree is written. It does NOT see a write
 * whose data object is built elsewhere and spread in (`data: patch`), and
 * `applyInboundMemberContactPatch` is exactly that shape — so that one is
 * asserted separately, by name, below. Stating the blind spot is the point: a
 * census that hides one is worse than no census, because the next reader
 * believes it.
 *
 * **Re-measure by running this test. Never edit the list by adding a file to
 * it without saying, in the same edit, which guard that file takes.**
 */
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

/**
 * Every file allowed to CLAIM a Xero contact id for a local record, and WHICH
 * guard it takes. The value is not decoration: a file added here without one is
 * a linker nobody has decided about.
 */
const DECLARED_LINKERS: Record<string, string> = {
  "src/lib/xero-contacts.ts":
    "findOrCreateXeroContact phase 2 and createXeroContactForMember. Phase 2 " +
    "takes lockXeroContactHome then assertXeroContactHasNoOtherHome; the " +
    "create needs no guard, because a contact Xero minted a moment ago can " +
    "have no other home (INV-INT-018).",
  "src/lib/xero-manual-contact-link.ts":
    "commitManualXeroContactLink, the operator's manual link, which takes the " +
    "contact-home key and then the refusal before it writes.",
  "src/lib/xero-member-import.ts":
    "the bulk import's two member creates, each taking the key before the " +
    "insert and the refusal inside the same transaction after it (#2939).",
  "src/lib/organisation-xero-contacts.ts":
    "the organisation-keyed resolve, which takes the key and the refusal from " +
    "the ORGANISATION side of the same rule.",
  "src/app/api/admin/xero/import-member-contact/route.ts":
    "the operator importing a Xero contact as a NEW member: it creates the " +
    "member carrying the contact id, and refuses first (INV-INT-018).",
};

/**
 * The writer this scan cannot see, asserted by name below instead — with what
 * makes the blind spot tolerable.
 */
const INVISIBLE_TO_THE_SCAN = "src/lib/xero-contact-create-recovery.ts";

/**
 * Two files write the column and are NOT linkers, which the non-null test above
 * is what distinguishes. Named here so the distinction is a stated fact rather
 * than a silent absence from the list.
 *
 *  - `xero-contact-home.ts` — `takeXeroContactFromSchoolsOwnMember` CLEARS the
 *    holder's id (`xeroContactId: null`) and lets the organisation side claim
 *    it. An unlink cannot give a contact a second home.
 *  - `member-merge.ts` — nulls the loser's id during the Xero teardown, for the
 *    same reason.
 */
const CLEARS_BUT_NEVER_CLAIMS = [
  "src/lib/xero-contact-home.ts",
  "src/lib/member-merge.ts",
];

const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const LINKED_MODELS = new Set(["member", "organisation"]);

function isProductionSource(file: string): boolean {
  // The production tree the policy is about. `prisma/demo-seed.ts` writes the
  // column too and is deliberately out of scope: it invents fixture contacts
  // for a demo database, links nothing to a real Xero organisation, and runs
  // nowhere near a club's books.
  return relativeSource(file).startsWith(`src${"/"}`);
}

/**
 * Does this call write `xeroContactId` to a NON-NULL value on a Member or an
 * Organisation?
 *
 * Non-null is the whole discrimination. `data: { xeroContactId: null }` is an
 * UNLINK — the account-deletion fence, the admin unlink route, the lifecycle
 * clear — and an unlink cannot give a contact a second home, which is the only
 * thing `INV-INT-018` is about. Counting them would bury the six real linkers
 * in a dozen files nobody needs to guard.
 */
function claimsAContact(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (!WRITE_METHODS.has(method)) return false;

  const target = node.expression.expression;
  const model = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isIdentifier(target)
      ? target.text
      : null;
  if (!model || !LINKED_MODELS.has(model.toLowerCase())) return false;

  const [arg] = node.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;

  let claims = false;
  const visitData = (value: ts.Expression) => {
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      if (!ts.isIdentifier(name) || name.text !== "xeroContactId") continue;
      if (property.initializer.kind === ts.SyntaxKind.NullKeyword) continue;
      claims = true;
    }
  };
  for (const property of arg.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (!ts.isIdentifier(name)) continue;
    // `data` on create/update/upsert; `create`/`update` on an upsert.
    if (name.text === "data" || name.text === "create" || name.text === "update") {
      visitData(property.initializer);
    }
  }
  return claims;
}

/** Production files that CLAIM a Xero contact id for a Member or Organisation. */
function discoverLinkerFiles(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles()) {
    if (!isProductionSource(file)) continue;
    const code = readFileSync(file, "utf8");
    if (!code.includes("xeroContactId")) continue;
    const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && claimsAContact(node)) {
        found.add(relativeSource(file));
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
  }
  return [...found].sort();
}

void sep;

describe("every Xero contact linker is declared (#2939, INV-INT-018)", () => {
  it("finds exactly the linkers the invariant accounts for", () => {
    /*
      THE POPULATION, not a memory of it. A new file writing the column fails
      here with its own path in the message, so whoever added it is handed the
      question — which guard does this one take — at the moment they can still
      answer it, rather than leaving the invariant asserting a completeness it
      no longer has.
    */
    const discovered = discoverLinkerFiles();
    const declared = Object.keys(DECLARED_LINKERS).sort();

    expect(
      discovered,
      "A file writes `Member.xeroContactId` or `Organisation.xeroContactId` " +
        "and is not declared in DECLARED_LINKERS. INV-INT-018 says every " +
        "linker takes the contact-home key and the two-homes refusal, with no " +
        "exception but INV-INT-020's one transfer. Add the file with WHICH " +
        "guard it takes — or give it one.",
    ).toEqual(declared);
  });

  it("counts an unlink as an unlink, not as a claim", () => {
    /*
      The non-null test is the whole discrimination. Without it a dozen files —
      the account-deletion fence, the admin unlink route, the lifecycle clear —
      would be in the list, burying the linkers that really do have to take the
      key. These two write the column and claim nothing.
    */
    const discovered = discoverLinkerFiles();
    for (const file of CLEARS_BUT_NEVER_CLAIMS) {
      expect(discovered, `${file} only ever writes null`).not.toContain(file);
    }
  });

  it("keeps a reason against every declared linker", () => {
    // A path with an empty reason is a file somebody added to make this pass.
    for (const [file, reason] of Object.entries(DECLARED_LINKERS)) {
      expect(reason.length, `${file} needs a stated guard`).toBeGreaterThan(40);
    }
  });

  it("names the writer the scan cannot see, rather than pretending it sees it", () => {
    /*
      `applyInboundMemberContactPatch` builds its `data` object incrementally
      and writes the variable, so no write EXPRESSION in that file names the
      column and the AST walk above cannot reach it. Asserted by name here, and
      its refusal is exercised end to end by
      `xero-two-homes-refusal-callers.test.ts`.
    */
    const source = readFileSync(
      sourceFiles().find(
        (candidate) => relativeSource(candidate) === INVISIBLE_TO_THE_SCAN,
      )!,
      "utf8",
    );
    // It takes the key and the refusal, which is what the invariant claims.
    expect(source).toContain("lockXeroContactHome(tx, input.xeroContactId)");
    expect(source).toContain("assertXeroContactHasNoOtherHome(tx, {");
  });

  it("proves the bulk member import's two creates take both", () => {
    const file = sourceFiles().find(
      (candidate) => relativeSource(candidate) === "src/lib/xero-member-import.ts",
    )!;
    const source = readFileSync(file, "utf8");

    // Two creates, two locks, two refusals — INV-INT-019's other retired
    // exception.
    expect(
      source.match(/lockXeroContactHome\(tx, contact\.contactId\)/g)?.length,
    ).toBe(2);
    expect(
      source.match(/assertXeroContactHasNoOtherHome\(tx, \{/g)?.length,
    ).toBe(2);
  });
});
