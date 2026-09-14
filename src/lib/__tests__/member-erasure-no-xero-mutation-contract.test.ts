/**
 * #3058 — erasing a member mutates no Xero CONTACT, and the tests say so.
 *
 * ## The claim, stated at the width it actually holds
 *
 * An earlier revision of this file said "erasing a member mutates nothing in
 * Xero". That was FALSE, and the guard below could not see why. The anonymising
 * erasure cancels the member's future bookings, and `cancelBooking` enqueues
 * account, refund and modification credit notes and kicks the Xero outbox — so
 * approving a deletion for a member with a paid future booking causes a
 * provider write. It is the ordinary cancellation behaviour, it would happen
 * whoever asked for the cancellation, and it belongs to the accounting ledger
 * rather than to the contact. But it is a Xero mutation, and a contract that
 * denied it was telling a treasurer something they could disprove by looking at
 * their own credit notes.
 *
 * What is true, and what this file holds, is the narrower claim the settled
 * contract on #3058 actually needs:
 *
 * > **No erasure path asks Xero to change, archive, blank or delete the
 * > member's CONTACT.** Xero keeps the contact, its details and every invoice
 * > raised against it; what happens to it is the treasurer's decision in their
 * > own system.
 *
 * Three separate things hold that, and only the first two are in this file:
 *
 * 1. **Neither erasure source names a provider call or an outbox enqueue.**
 * 2. **Every DIRECTLY imported module that reaches Xero at all is declared**,
 *    by name, with the reason. That is the check that would have caught the
 *    overclaim: `@/lib/booking-cancel` has always been on this list in fact,
 *    and was invisible to the old predicate.
 * 3. **The anonymised-member fence refuses a contact write.**
 *    `findOrCreateXeroContact` calls `assertMemberAvailableForXeroContactChange`
 *    before any provider call, so even the credit-note path's contact REPAIR —
 *    `retryXeroWriteWithContactRepair`, which falls back to
 *    `findOrCreateXeroContact` on a stale contact reference — cannot create or
 *    relink a contact for a member the erasure has anonymised. The hard delete
 *    leaves no `Member` row at all, so the same call throws before it reaches
 *    Xero. That fence is pinned by `xero-contact-create-recovery`'s own tests
 *    and is asserted here only as a reachable fact, not re-proved.
 *
 * ## Why the import check is DEPTH ONE, and what that does not cover
 *
 * Measured on this tree: 358 modules are reachable from the anonymising
 * erasure's import graph and **31 of them** reach a Xero provider call or an
 * outbox enqueue. A transitive allowlist over that is not a guard, it is a
 * census of the application. So the check is deliberately one level deep, where
 * the list is short enough to be read and argued with, and the declared-reach
 * entry is what makes the one real reach visible instead of hidden behind a
 * predicate that could not spell it.
 *
 * Parsed with TypeScript's own parser and walked as an AST, so prose about a
 * banned symbol — of which these files have a great deal — is never mistaken
 * for a call of it.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ErasureSource {
  /** The file, relative to the repository root. */
  path: string;
  /**
   * The exported function that performs the erasure. The POSITIVE half below is
   * scoped to it rather than to the file: `deletion-requests/[id]/route.ts` is
   * over a thousand lines and `member-lifecycle-actions.ts` holds a dozen
   * exported handlers, so a file-scoped proof is satisfied by any block
   * anywhere in it — the "passed for the wrong reason" shape this repository
   * names explicitly. The day a second handler in one of these files retires a
   * link, the erasure handler could stop retiring its own and a file-scoped
   * test would still be green.
   */
  erasureFunction: string;
  /**
   * Directly imported modules that themselves reach Xero, each with the reason
   * it is allowed. A new one fails the test, which is the point: adding an
   * import to an erasure path that queues provider work is a decision somebody
   * should have to write down.
   */
  declaredXeroReach: Record<string, string>;
}

const ERASURE_SOURCES: Record<string, ErasureSource> = {
  "the anonymising erasure (approved deletion request)": {
    path: "src/app/api/admin/deletion-requests/[id]/route.ts",
    erasureFunction: "POST",
    declaredXeroReach: {
      "@/lib/booking-cancel":
        "Erasure cancels the member's future PENDING/PAYMENT_PENDING/CONFIRMED " +
        "bookings, and cancelling a paid one enqueues a credit note. That is a " +
        "Xero write in the accounting ledger — the same one any other " +
        "cancellation makes — and it touches no contact.",
    },
  },
  "the hard delete (approved member lifecycle DELETE)": {
    path: "src/lib/member-lifecycle-actions.ts",
    erasureFunction: "reviewMemberDeleteRequest",
    declaredXeroReach: {},
  },
};

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
 * Names that either call Xero or queue something that will. None may be named
 * in an erasure source itself; a DIRECT import that names one must be declared.
 */
const PROVIDER_IDENTIFIERS = [
  "callXeroApi",
  "getAuthenticatedXeroClient",
  "findOrCreateXeroContact",
  "createXeroContactForMember",
  "updateXeroContact",
  "retryXeroWriteWithContactRepair",
];
/** Anything queued onto the Xero outbox is a provider write with a delay. */
const PROVIDER_IDENTIFIER_PREFIX = "enqueueXero";

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

function identifiers(node: ts.Node): Set<string> {
  const found = new Set<string>();
  walk(node, (child) => {
    if (ts.isIdentifier(child)) found.add(child.text);
  });
  return found;
}

/**
 * Resolve a `@/…` or relative specifier to a tracked file, or `null` for a
 * package. Deliberately tiny: it only has to answer "is there a file of ours
 * behind this import", which is all the declared-reach check needs.
 */
function resolveLocalModule(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = join(process.cwd(), "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = join(process.cwd(), fromFile, "..", specifier);
  } else {
    return null;
  }
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Does this module's source name a provider call or an outbox enqueue? */
function reachesXero(absolutePath: string): string[] {
  const text = readFileSync(absolutePath, "utf8");
  const source = ts.createSourceFile(
    absolutePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const used = identifiers(source);
  return [
    ...PROVIDER_IDENTIFIERS.filter((name) => used.has(name)),
    ...[...used].filter((name) => name.startsWith(PROVIDER_IDENTIFIER_PREFIX)),
  ].sort();
}

/** The declaration of one named exported function, wherever it is written. */
function findExportedFunction(
  source: ts.SourceFile,
  name: string,
): ts.Node | null {
  let found: ts.Node | null = null;
  walk(source, (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
  });
  return found;
}

describe.each(Object.entries(ERASURE_SOURCES))(
  "member erasure makes no Xero CONTACT mutation — %s",
  (_label, erasure) => {
    const source = parse(erasure.path);

    it("reaches exactly one Xero-named module, and only for the deletion fence", () => {
      /*
        MATCHED ANYWHERE IN THE SPECIFIER, not at a path-segment start. The
        earlier `/(^|\/)xero/` test read `@/lib/membership-cancellation-xero`
        and `@/lib/organisation-xero-contacts` as not-Xero-modules, so an
        erasure path could have imported either and passed. Both exist on this
        tree today, and both archive or write contacts.
      */
      const xeroModules = moduleSpecifiers(source).filter((specifier) =>
        /xero/i.test(specifier),
      );
      expect([...new Set(xeroModules)]).toEqual([ALLOWED_XERO_MODULE]);

      for (const name of namedImportsFrom(source, ALLOWED_XERO_MODULE)) {
        expect(
          ALLOWED_XERO_IMPORTS.has(name),
          `${erasure.path} takes "${name}" from ${ALLOWED_XERO_MODULE}. Erasure may take only the ` +
            "fence and its refusal from that module. If this is a new read, add it here with its " +
            "reason; if it writes to Xero, it does not belong on an erasure path at all (#3058).",
        ).toBe(true);
      }
    });

    it("names no provider call and queues no Xero outbox work itself", () => {
      const used = identifiers(source);
      for (const banned of PROVIDER_IDENTIFIERS) {
        expect(
          used.has(banned),
          `${erasure.path} names ${banned}. Erasing a member asks Xero for nothing (#3058).`,
        ).toBe(false);
      }
      const queued = [...used].filter((name) =>
        name.startsWith(PROVIDER_IDENTIFIER_PREFIX),
      );
      expect(
        queued,
        `${erasure.path} queues Xero outbox work. An outbox entry is a provider write with a delay.`,
      ).toEqual([]);
    });

    it("declares every directly imported module that reaches Xero", () => {
      /*
        The check the old allowlist could not make. An erasure source reaches
        Xero through modules whose NAMES say nothing about Xero — `booking-cancel`
        is the one that already existed — so asking "is this specifier spelled
        like a Xero module?" was asking the wrong question. This asks the module
        itself.
      */
      const undeclared: Record<string, string[]> = {};
      for (const specifier of new Set(moduleSpecifiers(source))) {
        const resolved = resolveLocalModule(specifier, erasure.path);
        if (!resolved) continue;
        const hits = reachesXero(resolved);
        if (hits.length === 0) continue;
        if (specifier in erasure.declaredXeroReach) continue;
        undeclared[specifier] = hits.slice(0, 4);
      }
      expect(
        undeclared,
        `${erasure.path} imports a module that reaches Xero and is not declared. Erasure asks Xero ` +
          "for nothing about the CONTACT, but it is not free of provider effects altogether — " +
          "cancelling a paid booking enqueues a credit note. Add the module to declaredXeroReach " +
          "with the reason, and check the effect is about invoices rather than about the contact " +
          "(#3058, INV-INT-024).",
      ).toEqual({});

      // And the declaration does not rot: an entry that stopped reaching Xero
      // is a stale exemption, which is how an allowlist becomes decoration.
      for (const specifier of Object.keys(erasure.declaredXeroReach)) {
        const resolved = resolveLocalModule(specifier, erasure.path);
        expect(resolved, `${specifier} is declared but does not resolve`).not.toBeNull();
        expect(
          reachesXero(resolved as string).length,
          `${specifier} is declared as reaching Xero from ${erasure.path} and no longer does. ` +
            "Remove the declaration.",
        ).toBeGreaterThan(0);
      }
    });

    it("still tears the LOCAL link down inside the erasure function itself", () => {
      /*
        The positive half. "Asks Xero for nothing" is also true of an erasure
        that stopped doing anything — and one that stopped retiring the link
        would empty the `INV-INT-024` review silently rather than fail, because
        the retired link is its only durable record of which contact the member
        had.

        SCOPED TO THE ERASURE FUNCTION. A file-scoped walk over a
        thousand-line route is satisfied by any `xeroObjectLink.updateMany`
        anywhere in it, including one a different handler added.
      */
      const fn = findExportedFunction(source, erasure.erasureFunction);
      expect(
        fn,
        `${erasure.path} no longer exports ${erasure.erasureFunction}. If the erasure moved, ` +
          "point this contract at its new home rather than widening it back to the file.",
      ).not.toBeNull();

      let nullsThePointer = false;
      let retiresTheLink = false;
      walk(fn as ts.Node, (node) => {
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
      expect(
        nullsThePointer,
        `${erasure.path} → ${erasure.erasureFunction} no longer nulls Member.xeroContactId`,
      ).toBe(true);
      expect(
        retiresTheLink,
        `${erasure.path} → ${erasure.erasureFunction} no longer retires the Xero contact link`,
      ).toBe(true);
    });
  },
);

describe("the Xero-module predicate sees the modules that exist (#3058)", () => {
  /**
   * Asserted directly, because the widening is not otherwise observable: no
   * erasure source imports one of these TODAY, so a test over the diff alone
   * would pass against the broken predicate as happily as against the fixed
   * one. These three are real files on this tree, and the first two archive or
   * write Xero contacts.
   */
  const MODULES_THE_OLD_PREDICATE_MISSED = [
    "@/lib/membership-cancellation-xero",
    "@/lib/organisation-xero-contacts",
    "@/lib/organisation-xero-contact-persons",
  ];

  it.each(MODULES_THE_OLD_PREDICATE_MISSED)(
    "recognises %s as a Xero module",
    (specifier) => {
      expect(existsSync(resolveLocalModule(specifier, "src/lib/x.ts") ?? "")).toBe(
        true,
      );
      expect(
        /xero/i.test(specifier),
        `${specifier} is a Xero module. The earlier predicate matched "xero" only at a ` +
          "path-segment start, so an erasure path could have imported it and passed the " +
          "allowlist unseen (#3058).",
      ).toBe(true);
    },
  );
});

describe("the contact-write fence is what makes the narrow claim true (#3058)", () => {
  it("refuses a contact write for an anonymised member before any provider call", () => {
    /*
      Leg 3 of the argument in the header, asserted as a reachable fact. The
      credit note an erasure's booking cancellation enqueues can, on a stale
      contact reference, fall back to `findOrCreateXeroContact` — and THAT is
      the one path by which an erasure could otherwise create a Xero contact
      for the person it just erased. It cannot, because
      `findOrCreateXeroContact` asserts the member is available for a contact
      change before it does anything else.
    */
    const source = parse("src/lib/xero-contacts.ts");
    const fn = findExportedFunction(source, "findOrCreateXeroContact");
    expect(fn).not.toBeNull();
    expect(
      identifiers(fn as ts.Node).has("assertMemberAvailableForXeroContactChange"),
      "findOrCreateXeroContact no longer refuses an anonymised member. That refusal is what " +
        "stops an erasure's own credit-note contact repair from creating a Xero contact for the " +
        "member it just erased (#3058, INV-INT-024).",
    ).toBe(true);
  });
});

describe("the review surface itself makes no Xero contact write (#3058)", () => {
  const ROUTE = "src/app/api/admin/xero/erased-member-contacts/route.ts";

  it("exports only the handlers this contract knows about", () => {
    /*
      The old version of this walked FUNCTION DECLARATIONS only, so
      `export const POST = async (…) => …` or `export { handler as POST }`
      passed it unseen. Every export form is collected here, and a
      `export * from` fails outright because nothing can see through one.
    */
    const source = parse(ROUTE);
    const exported = new Set<string>();
    let hasStarExport = false;
    walk(source, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.add(node.name.text);
      }
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
        }
      }
      if (ts.isClassDeclaration(node) && node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exported.add(node.name.text);
      }
      if (ts.isExportDeclaration(node)) {
        if (!node.exportClause) {
          hasStarExport = true;
          return;
        }
        if (ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            exported.add(element.name.text);
          }
        }
        if (ts.isNamespaceExport(node.exportClause)) hasStarExport = true;
      }
      if (ts.isExportAssignment(node)) exported.add("default");
    });

    expect(
      hasStarExport,
      `${ROUTE} re-exports a whole module. Nothing can see what that adds to the route's HTTP ` +
        "surface, so it is refused outright (#3058).",
    ).toBe(false);
    expect([...exported].sort()).toEqual(["GET", "POST"]);
  });

  it("makes no Xero contact write, whatever it reads", () => {
    /*
      The POST re-checks the listed contacts' STATUS in Xero. That is a read
      toward the provider — `getContacts` — and a local write of nothing but a
      status. A contact write would defeat the whole issue, so the route may
      not name one however it evolves.
    */
    const used = identifiers(parse(ROUTE));
    for (const banned of [
      "updateContact",
      "updateOrCreateContacts",
      "createContacts",
      "findOrCreateXeroContact",
      "createXeroContactForMember",
      "updateXeroContact",
    ]) {
      expect(
        used.has(banned),
        `${ROUTE} names ${banned}. This surface reads Xero and changes nothing in it (#3058).`,
      ).toBe(false);
    }
    const queued = [...used].filter((name) =>
      name.startsWith(PROVIDER_IDENTIFIER_PREFIX),
    );
    expect(queued, `${ROUTE} queues Xero outbox work.`).toEqual([]);
  });
});
