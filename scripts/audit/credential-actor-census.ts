/**
 * The credential-actor census (#2723).
 *
 * WHY THIS EXISTS. Every mutation of the encrypted `IntegrationCredential`
 * store must carry explicit actor context, and the store's required `actor`
 * argument is what makes omitting it a compile error. A type is the right first
 * line and it is not the only one it needs: an `as never` cast in a test double,
 * a value crossing from untyped JavaScript, a `@ts-expect-error`, or a writer
 * that skips the store and reaches the Prisma delegate directly all get past it.
 * This tool answers the question nothing in the repository could answer before:
 * "how many credential mutators are called, from where, and which of them do not
 * name an actor?" The contract test beside it
 * (`src/lib/__tests__/credential-actor-census.test.ts`) turns that answer into a
 * gate.
 *
 * IT ENUMERATES FROM THE TREE, NOT FROM A LIST. That distinction is the whole
 * value. A population measured by walking a hand-written set of paths is not the
 * population — it is the list, and the list is what goes stale. Everything below
 * comes from walking `src/`, `scripts/`, `e2e/` and `prisma/` on every run.
 *
 * WHAT COUNTS AS A SITE. Three ways to mutate a stored credential:
 *
 *  1. `setIntegrationCredential(params)`     — the store's upsert/CAS writer
 *  2. `ensureGeneratedCredential(params)`    — the store's create-only generator
 *  3. `deleteIntegrationCredential(params)`  — the store's remover
 *
 * and one way to go round them all:
 *
 *  4. `<client>.integrationCredential.<mutating DML>(…)` — a direct Prisma write
 *     that never reaches the store, so no required argument can catch it.
 *
 * Form 4 is inventoried separately as a BYPASS. The store module itself is the
 * approved home for those statements; anywhere else is a finding. Delegate
 * aliases (`const rows = tx.integrationCredential`) and element access
 * (`tx["integrationCredential"]`) are both followed, because the audit census's
 * review demonstrated each as a silent bypass of a property-access-only check.
 *
 * ONE FORM IS NOT TYPESCRIPT AT ALL: raw SQL DML against `"IntegrationCredential"`
 * in a migration, or through `$executeRaw*` from TypeScript. Both are scanned,
 * because a migration that rewrites a credential row is a mutation nobody can
 * attribute either. READS are deliberately not counted — a `SELECT` carries no
 * actor and needs none, and counting them would bury the writes.
 *
 * WHAT IT STILL DOES NOT SEE is inherited from the shared walk
 * (`ts-call-site-scan.ts`) and stated there: no type checker, so an alias made
 * by assignment rather than declaration, or a delegate handed back from a
 * helper, is invisible. That is why the required ARGUMENT and the runtime
 * assertions in `integration-credential-actor.ts` are the primary defences and
 * this census is the backstop.
 *
 * Run it: `npm run credential:census` prints a deterministic TSV.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

import {
  eachNode,
  findTopLevelProperty,
  isDeclarationName,
  listSourceFiles,
  literalText,
  parseSourceFile,
  resolveObjectLiteral,
  symbolChain,
  toPosix,
  unwrap,
  type ResolvedObject,
} from "./ts-call-site-scan";

/** The module that owns the credential boundary; its own writes are not sites. */
export const CREDENTIAL_BOUNDARY_MODULES = [
  "src/lib/integration-credentials.ts",
  "src/lib/integration-credential-claim.ts",
] as const;

/** The mutators every credential writer must go through. */
export const CREDENTIAL_MUTATORS = [
  "setIntegrationCredential",
  "ensureGeneratedCredential",
  "deleteIntegrationCredential",
] as const;

export type CredentialMutator = (typeof CREDENTIAL_MUTATORS)[number];

/**
 * Which mutators require a declared write expectation as well as an actor.
 *
 * `ensureGeneratedCredential` is deliberately not one of them: its expectation
 * is not the caller's to choose — create-only, never overwrite a readable row —
 * so an `expect` parameter there would be a decision with one legal answer.
 */
const MUTATORS_REQUIRING_EXPECTATION: ReadonlySet<string> = new Set([
  "setIntegrationCredential",
  "deleteIntegrationCredential",
]);

/** The Prisma delegate a bypass reaches. */
const CREDENTIAL_DELEGATE = "integrationCredential";

/** Prisma methods on that delegate that change stored credential material. */
const MUTATING_DML = new Set([
  "create",
  "createMany",
  "upsert",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

const RAW_SQL_METHODS = new Set([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
]);

/**
 * What the call site says about the actor.
 *
 *  - `literal`   an inline object whose `kind` is a string literal, so the
 *                reviewer can read "admin" or "system" at the site.
 *  - `forwarded` an `actor` key is present but decided elsewhere — a variable, a
 *                shorthand property, a spread, a parameter passed through. This
 *                is a legitimate shape (a route hoists one actor for nine
 *                writes) and it is PINNED rather than accepted silently.
 *  - `absent`    no `actor` key at all. This is the population that must be
 *                empty, and the one a seeded actorless writer lands in.
 */
export type CredentialActorEvidence =
  | { kind: "literal"; value: string }
  | { kind: "forwarded"; expression: string }
  | { kind: "absent" };

/** The same three answers for the declared write expectation. */
export type CredentialExpectationEvidence =
  | { kind: "literal"; value: string }
  | { kind: "forwarded"; expression: string }
  | { kind: "absent" }
  /** The mutator does not take one — `ensureGeneratedCredential`. */
  | { kind: "not-applicable" };

export type CredentialWriteSite = {
  /** Repo-relative POSIX path. */
  file: string;
  /** Stable identity: enclosing symbol chain plus an ordinal among its peers. */
  id: string;
  symbol: string;
  line: number;
  mutator: CredentialMutator;
  actor: CredentialActorEvidence;
  expectation: CredentialExpectationEvidence;
};

export type CredentialBypassSite = {
  file: string;
  id: string;
  symbol: string;
  line: number;
  /** `integrationCredential.upsert`, or `raw.$executeRaw`. */
  statement: string;
};

export type CredentialActorCensus = {
  /** Every call of a store mutator, outside the boundary modules. */
  sites: CredentialWriteSite[];
  /** Sites passing no `actor` at all. MUST be empty. */
  actorless: CredentialWriteSite[];
  /** Sites whose actor is decided elsewhere. Pinned, not forbidden. */
  actorForwarded: CredentialWriteSite[];
  /** Sites that must declare an expectation and pass none. MUST be empty. */
  expectationless: CredentialWriteSite[];
  /** Direct Prisma/raw writes to the table outside the boundary modules. */
  bypasses: CredentialBypassSite[];
  /** Files walked, so a scan that resolved nothing cannot read as clean. */
  filesScanned: number;
};

const SCAN_ROOTS = ["src", "scripts", "e2e", "prisma"] as const;

/**
 * `__mocks__` and `generated` hold no real writer. `__tests__` and the spec
 * files are skipped by the shared walk's own test-file filter — a test double
 * calling the store is not a production writer, and pinning them would make the
 * census move every time somebody adds a case.
 *
 * `e2e` is NOT skipped, unlike the audit census: the E2E stack seeds real
 * credentials through the real store, so a seed that stopped naming an actor is
 * a finding.
 */
const SKIP_DIRECTORIES = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  "generated",
  "fixtures",
  "test-utils",
]);

function isBoundaryModule(file: string): boolean {
  return (CREDENTIAL_BOUNDARY_MODULES as readonly string[]).includes(file);
}

/** The `actor` / `expect` evidence on one resolved params object. */
function resolveKeyEvidence(
  params: ResolvedObject | null,
  key: string,
  discriminator: string,
): CredentialActorEvidence {
  if (params === null) return { kind: "forwarded", expression: "(not a literal)" };
  const property = findTopLevelProperty(params, key);
  if (!property) {
    // Fail closed: an object with a key this walk cannot NAME might be setting
    // exactly this one, so it is "decided elsewhere", never "absent".
    return params.unreadableKeys
      ? { kind: "forwarded", expression: "(unreadable keys)" }
      : { kind: "absent" };
  }
  if (property.kind === "opaque") {
    return { kind: "forwarded", expression: property.text };
  }
  const inner = unwrap(property.value);
  if (ts.isObjectLiteralExpression(inner)) {
    const resolved = resolveObjectLiteral(inner);
    const discriminatorProperty = findTopLevelProperty(resolved, discriminator);
    if (discriminatorProperty?.kind === "assignment") {
      const text = literalText(discriminatorProperty.value);
      if (text !== null) return { kind: "literal", value: text };
    }
    return { kind: "forwarded", expression: `(${discriminator} not literal)` };
  }
  return { kind: "forwarded", expression: inner.getText().replace(/\s+/g, " ") };
}

function resolveParams(argument: ts.Expression | undefined): ResolvedObject | null {
  if (!argument) return null;
  const inner = unwrap(argument);
  if (!ts.isObjectLiteralExpression(inner)) return null;
  return resolveObjectLiteral(inner);
}

/** Is this expression the `integrationCredential` Prisma delegate? */
function isCredentialDelegate(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === CREDENTIAL_DELEGATE;
  }
  if (ts.isElementAccessExpression(inner)) {
    return literalText(inner.argumentExpression) === CREDENTIAL_DELEGATE;
  }
  return ts.isIdentifier(inner) && inner.text === CREDENTIAL_DELEGATE;
}

/** Locals holding the delegate, so `const c = tx.integrationCredential` counts. */
function collectDelegateAliases(ast: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  eachNode(ast, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCredentialDelegate(node.initializer)
    ) {
      aliases.add(node.name.text);
    }
  });
  return aliases;
}

/** `INSERT`/`UPDATE`/`DELETE` against the table, in one SQL string. */
export function classifyCredentialSql(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const table = /"?(?:public"?\.)?"?IntegrationCredential"?/i;
  if (!table.test(flat)) return null;
  if (/\bINSERT\s+INTO\s+"?(?:public"?\.)?"?IntegrationCredential"?/i.test(flat)) {
    return "insert";
  }
  if (/\bUPDATE\s+"?(?:public"?\.)?"?IntegrationCredential"?/i.test(flat)) {
    return "update";
  }
  if (/\bDELETE\s+FROM\s+"?(?:public"?\.)?"?IntegrationCredential"?/i.test(flat)) {
    return "delete";
  }
  return null;
}

/** Every argument of a `$executeRawUnsafe(...)`-style call, as one string. */
function rawSqlText(call: ts.CallExpression): string {
  return call.arguments.map((argument) => argument.getText()).join(" ");
}

function scanFile(file: string, repoRoot: string): {
  sites: CredentialWriteSite[];
  bypasses: CredentialBypassSite[];
} {
  const relativePath = toPosix(relative(repoRoot, file));
  const ast = parseSourceFile(file);
  const aliases = collectDelegateAliases(ast);
  const sites: CredentialWriteSite[] = [];
  const bypasses: CredentialBypassSite[] = [];
  const ordinals = new Map<string, number>();

  const nextId = (symbol: string): string => {
    const seen = ordinals.get(symbol) ?? 0;
    ordinals.set(symbol, seen + 1);
    return `${relativePath}::${symbol}#${seen}`;
  };

  eachNode(ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (isDeclarationName(node)) return;

    const line =
      ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const symbol = symbolChain(node);
    const callee = unwrap(node.expression);

    // --- form 1-3: a store mutator -----------------------------------------
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;

    if (
      calleeName !== null &&
      (CREDENTIAL_MUTATORS as readonly string[]).includes(calleeName)
    ) {
      if (!isBoundaryModule(relativePath)) {
        const params = resolveParams(node.arguments[0]);
        const mutator = calleeName as CredentialMutator;
        sites.push({
          file: relativePath,
          id: nextId(symbol),
          symbol,
          line,
          mutator,
          actor: resolveKeyEvidence(params, "actor", "kind"),
          expectation: MUTATORS_REQUIRING_EXPECTATION.has(mutator)
            ? resolveKeyEvidence(params, "expect", "expect")
            : { kind: "not-applicable" },
        });
      }
      return;
    }

    // --- form 4: a direct Prisma write -------------------------------------
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : literalText(callee.argumentExpression);
      const receiver = callee.expression;
      const receiverIsDelegate =
        isCredentialDelegate(receiver) ||
        (ts.isIdentifier(unwrap(receiver)) &&
          aliases.has((unwrap(receiver) as ts.Identifier).text));
      if (
        method !== null &&
        MUTATING_DML.has(method) &&
        receiverIsDelegate &&
        !isBoundaryModule(relativePath)
      ) {
        bypasses.push({
          file: relativePath,
          id: nextId(symbol),
          symbol,
          line,
          statement: `${CREDENTIAL_DELEGATE}.${method}`,
        });
      }
    }

    // --- raw SQL from TypeScript -------------------------------------------
    if (
      ts.isPropertyAccessExpression(callee) &&
      RAW_SQL_METHODS.has(callee.name.text) &&
      classifyCredentialSql(rawSqlText(node)) !== null
    ) {
      bypasses.push({
        file: relativePath,
        id: nextId(symbol),
        symbol,
        line,
        statement: `raw.${callee.name.text}`,
      });
    }
  });

  // A tagged template (`prisma.$executeRaw`...`) is not a CallExpression, so it
  // is walked on its own.
  eachNode(ast, (node) => {
    if (!ts.isTaggedTemplateExpression(node)) return;
    const tag = unwrap(node.tag);
    if (!ts.isPropertyAccessExpression(tag)) return;
    if (!RAW_SQL_METHODS.has(tag.name.text)) return;
    if (classifyCredentialSql(node.template.getText()) === null) return;
    const symbol = symbolChain(node);
    bypasses.push({
      file: relativePath,
      id: nextId(symbol),
      symbol,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      statement: `raw.${tag.name.text}`,
    });
  });

  return { sites, bypasses };
}

function listSqlFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSqlFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".sql")) out.push(full);
  }
  return out;
}

export function scanCredentialActorCensus(
  repoRoot: string = process.cwd(),
): CredentialActorCensus {
  const sites: CredentialWriteSite[] = [];
  const bypasses: CredentialBypassSite[] = [];
  let filesScanned = 0;

  for (const root of SCAN_ROOTS) {
    const rootPath = join(repoRoot, root);
    let files: string[] = [];
    try {
      files = listSourceFiles(rootPath, [], SKIP_DIRECTORIES);
    } catch {
      continue; // a root that does not exist in this tree
    }
    for (const file of files) {
      filesScanned += 1;
      const result = scanFile(file, repoRoot);
      sites.push(...result.sites);
      bypasses.push(...result.bypasses);
    }
  }

  // Migration SQL. A migration that rewrites a credential row is a mutation
  // nobody can attribute, so it is inventoried with the TypeScript bypasses.
  let sqlFiles: string[] = [];
  try {
    sqlFiles = listSqlFiles(join(repoRoot, "prisma", "migrations"), []);
  } catch {
    sqlFiles = [];
  }
  for (const file of sqlFiles) {
    filesScanned += 1;
    const text = readFileSync(file, "utf8");
    const kind = classifyCredentialSql(text);
    if (kind === null) continue;
    const relativePath = toPosix(relative(repoRoot, file));
    bypasses.push({
      file: relativePath,
      id: `${relativePath}::<sql>#0`,
      symbol: "<sql>",
      line: 1,
      statement: `sql.${kind}`,
    });
  }

  const byId = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  sites.sort(byId);
  bypasses.sort(byId);

  return {
    sites,
    actorless: sites.filter((site) => site.actor.kind === "absent"),
    actorForwarded: sites.filter((site) => site.actor.kind === "forwarded"),
    expectationless: sites.filter((site) => site.expectation.kind === "absent"),
    bypasses,
    filesScanned,
  };
}

export function describeCredentialActor(
  evidence: CredentialActorEvidence,
): string {
  if (evidence.kind === "literal") return evidence.value;
  if (evidence.kind === "forwarded") return `(forwarded) ${evidence.expression}`;
  return "(absent)";
}

export function describeCredentialExpectation(
  evidence: CredentialExpectationEvidence,
): string {
  if (evidence.kind === "literal") return evidence.value;
  if (evidence.kind === "forwarded") return `(forwarded) ${evidence.expression}`;
  return `(${evidence.kind})`;
}

export function renderCredentialCensusTsv(
  census: CredentialActorCensus,
): string {
  const rows = [
    ["file", "symbol", "line", "mutator", "actor", "expectation"].join("\t"),
  ];
  for (const site of census.sites) {
    rows.push(
      [
        site.file,
        site.symbol,
        String(site.line),
        site.mutator,
        describeCredentialActor(site.actor),
        describeCredentialExpectation(site.expectation),
      ].join("\t"),
    );
  }
  for (const bypass of census.bypasses) {
    rows.push(
      [bypass.file, bypass.symbol, String(bypass.line), bypass.statement, "-", "-"].join(
        "\t",
      ),
    );
  }
  return rows.join("\n");
}

function main(): void {
  const census = scanCredentialActorCensus();
  process.stdout.write(`${renderCredentialCensusTsv(census)}\n`);
  process.stdout.write(
    `\n# files scanned: ${census.filesScanned}` +
      `\n# mutator call sites: ${census.sites.length}` +
      `\n# actorless: ${census.actorless.length}` +
      `\n# actor forwarded: ${census.actorForwarded.length}` +
      `\n# expectationless: ${census.expectationless.length}` +
      `\n# bypasses: ${census.bypasses.length}\n`,
  );
}

// `tsx scripts/audit/credential-actor-census.ts` runs the census; importing it
// (the contract test does) must not. The path is matched in full rather than by
// a substring, and through `toPosix`, so the guard behaves the same on Windows.
if (
  process.argv[1] &&
  toPosix(process.argv[1]).endsWith("scripts/audit/credential-actor-census.ts")
) {
  main();
}
