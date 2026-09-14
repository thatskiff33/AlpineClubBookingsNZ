/**
 * #3058 — erasing a member mutates nothing in Xero, and the tests say so.
 *
 * This is the acceptance criterion "tests fail if a member-erasure path
 * attempts to blank, delete or anonymise a Xero contact", and it is a CONTRACT
 * over the two erasure sources rather than a behavioural test, because the
 * defect it guards against is a line somebody adds later. A behavioural test
 * proves what today's code does; only a contract can fail on tomorrow's.
 *
 * THE RULE IS AN IMPORT ALLOWLIST, NOT A NAME BLACKLIST. A blacklist of
 * provider function names goes stale the day somebody exports a new one, and
 * the erasure paths would pass while calling it. What is asserted instead is
 * the shape that actually holds today and is cheap to keep holding: each
 * erasure source reaches EXACTLY ONE Xero module, `xero-contact-create-recovery`,
 * and takes from it only the fence and the refusal that let erasure decline to
 * run while a contact create is in flight. Every provider call, every outbox
 * enqueue and every contact write in this repository lives behind some other
 * module, so a new one cannot be reached without adding an import the allowlist
 * refuses. A short blacklist of identifiers backs it up, for the one shape an
 * import allowlist cannot see — a dynamic `await import(...)`.
 *
 * AND A POSITIVE HALF, because "changes nothing in Xero" would also be
 * satisfied by an erasure that stopped doing anything at all. The LOCAL
 * teardown is pinned too: the pointer is nulled and the canonical link is
 * retired, which is what leaves the durable record `INV-INT-024`'s review
 * reads. An erasure that quietly stopped retiring the link would silently empty
 * that screen instead of failing.
 *
 * Parsed with TypeScript's own parser and walked as an AST, so prose about a
 * banned symbol — of which these two files have a great deal — is never mistaken
 * for a call of it. That is the same reason the view-only banner contract parses
 * rather than greps.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The two paths that erase a member. Both leave Xero exactly as it was. */
const ERASURE_SOURCES = {
  "the anonymising erasure (approved deletion request)":
    "src/app/api/admin/deletion-requests/[id]/route.ts",
  "the hard delete (approved member lifecycle DELETE)":
    "src/lib/member-lifecycle-actions.ts",
} as const;

/**
 * The ONE Xero module an erasure path may reach, and the only reason it may.
 * The fence locks the member row and refuses to erase while a Xero contact
 * create is still in flight for them — a read and a refusal, never a write.
 */
const ALLOWED_XERO_MODULE = "@/lib/xero-contact-create-recovery";
const ALLOWED_XERO_IMPORTS = new Set([
  "assertNoMemberContactChangeBlockerForDeletion",
  "DELETED_ACCOUNT_PASSWORD_HASH",
  "lockMemberForAccountDeletionXeroFence",
  "XERO_CONTACT_OPERATION_RESOLVE_REMEDY",
  "XeroContactCreateBlocksDeletionError",
]);

/**
 * The backstop for a dynamic import. Every one of these either calls Xero or
 * queues something that will; none may be named in an erasure path at all.
 */
const FORBIDDEN_IDENTIFIERS = [
  "callXeroApi",
  "getAuthenticatedXeroClient",
  "findOrCreateXeroContact",
  "createXeroContactForMember",
  "updateXeroContact",
  "retryXeroWriteWithContactRepair",
];
/** Anything queued onto the Xero outbox is a provider write with a delay. */
const FORBIDDEN_IDENTIFIER_PREFIX = "enqueueXero";

function parse(relativePath: string): ts.SourceFile {
  const full = join(process.cwd(), relativePath);
  return ts.createSourceFile(
    full,
    readFileSync(full, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Every module specifier this file imports from, static or dynamic. */
function moduleSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
  });
  return found;
}

function namedImportsFrom(source: ts.SourceFile, specifier: string): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== specifier
    ) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) found.push(element.name.text);
    }
  });
  return found;
}

function identifiers(source: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  walk(source, (node) => {
    if (ts.isIdentifier(node)) found.add(node.text);
  });
  return found;
}

describe.each(Object.entries(ERASURE_SOURCES))(
  "member erasure makes no Xero mutation — %s",
  (_label, relativePath) => {
    const source = parse(relativePath);

    it("reaches exactly one Xero module, and only for the deletion fence", () => {
      const xeroModules = moduleSpecifiers(source).filter((specifier) =>
        /(^|\/)xero/.test(specifier.replace(/^@\/lib\//, "")),
      );
      expect([...new Set(xeroModules)]).toEqual([ALLOWED_XERO_MODULE]);

      for (const name of namedImportsFrom(source, ALLOWED_XERO_MODULE)) {
        expect(
          ALLOWED_XERO_IMPORTS.has(name),
          `${relativePath} takes "${name}" from ${ALLOWED_XERO_MODULE}. Erasure may take only the ` +
            "fence and its refusal from that module. If this is a new read, add it here with its " +
            "reason; if it writes to Xero, it does not belong on an erasure path at all (#3058).",
        ).toBe(true);
      }
    });

    it("names no provider call and queues no Xero outbox work", () => {
      const used = identifiers(source);
      for (const banned of FORBIDDEN_IDENTIFIERS) {
        expect(
          used.has(banned),
          `${relativePath} names ${banned}. Erasing a member performs no Xero mutation (#3058).`,
        ).toBe(false);
      }
      const queued = [...used].filter((name) =>
        name.startsWith(FORBIDDEN_IDENTIFIER_PREFIX),
      );
      expect(
        queued,
        `${relativePath} queues Xero outbox work. An outbox entry is a provider write with a delay.`,
      ).toEqual([]);
    });

    it("still tears the LOCAL link down, which is what the review reads", () => {
      /*
        The positive half. "Mutates nothing in Xero" is also true of an erasure
        that stopped doing anything — and one that stopped retiring the link
        would empty the `INV-INT-024` review silently rather than fail, because
        the retired link is its only durable record of which contact the member
        had.
      */
      let nullsThePointer = false;
      let retiresTheLink = false;
      walk(source, (node) => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "xeroContactId" &&
          node.initializer.kind === ts.SyntaxKind.NullKeyword
        ) {
          nullsThePointer = true;
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "updateMany" &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === "xeroObjectLink"
        ) {
          retiresTheLink = true;
        }
      });
      expect(nullsThePointer, `${relativePath} no longer nulls Member.xeroContactId`).toBe(true);
      expect(retiresTheLink, `${relativePath} no longer retires the Xero contact link`).toBe(true);
    });
  },
);

describe("the review surface itself writes nothing (#3058)", () => {
  const ROUTE = "src/app/api/admin/xero/erased-member-contacts/route.ts";

  it("exports a GET and no mutating handler", () => {
    const source = parse(ROUTE);
    const exported = new Set<string>();
    walk(source, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.add(node.name.text);
      }
    });
    expect([...exported]).toEqual(["GET"]);
  });
});
