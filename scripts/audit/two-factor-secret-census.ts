/**
 * The two-factor secret census (#3454).
 *
 * WHY THIS EXISTS. A member's second factor is a credential: the encrypted
 * authenticator-app secret on `Member.totpSecret`, the `twoFactorEnabled` /
 * `twoFactorMethod` switch beside it, and the hashed recovery codes. #3454 made
 * enrolment, recovery-code replacement and the account-erasure clear each write
 * an actor-aware audit row in the same transaction (`two-factor-audit.ts`). A
 * required argument binds the callers of those functions, and only those: a new
 * `tx.member.update({ data: { totpSecret: null } })` somewhere else would
 * compile, write no row, and trip nothing. So this walks the tree for every
 * statement that writes one of those fields or the recovery-code table, and
 * the contract test pins the set — a new writer cannot land without a reviewed
 * row saying how it is audited.
 *
 * WHAT COUNTS AS A SITE.
 *
 *  1. A Prisma write (`create`, `createMany`, `update`, `updateMany`, `upsert`
 *     and their `…AndReturn` forms) whose `data`, `create` or `update` object
 *     names `totpSecret`, `twoFactorEnabled` or `twoFactorMethod` — as a key or
 *     a shorthand property.
 *  2. Any write to the `twoFactorRecoveryCode` delegate — every method that is
 *     not a read, the same inverted rule the credential census uses.
 *
 * WHAT IT DOES NOT SEE, stated rather than implied: a field reached through a
 * SPREAD (`data: { ...patch }`) or a computed key, a delegate parked in a local,
 * and raw SQL. Those are the same holes the shared walk (`ts-call-site-scan.ts`)
 * documents; the required actor on the audited functions is the primary
 * defence and this census is the backstop for the plain, likely shape.
 *
 * Run it: `pnpm exec tsx scripts/audit/two-factor-secret-census.ts`.
 */
import { join, relative } from "node:path";

import ts from "typescript";

import {
  eachNode,
  isDeclarationName,
  listSourceFiles,
  parseSourceFile,
  propertyName,
  symbolChain,
  toPosix,
  unwrap,
} from "./ts-call-site-scan";

/** The `Member` columns that hold or switch the second factor. */
export const TWO_FACTOR_SECRET_FIELDS = [
  "totpSecret",
  "twoFactorEnabled",
  "twoFactorMethod",
] as const;

const SECRET_FIELD_SET: ReadonlySet<string> = new Set(TWO_FACTOR_SECRET_FIELDS);

const RECOVERY_CODE_DELEGATE = "twoFactorRecoveryCode";

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

const READ_METHODS: ReadonlySet<string> = new Set([
  "aggregate",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);

const PAYLOAD_KEYS: ReadonlySet<string> = new Set(["data", "create", "update"]);

const SCAN_ROOTS = ["src", "scripts", "e2e", "prisma"] as const;

const SKIP_DIRECTORIES = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  "generated",
  "fixtures",
  "test-utils",
]);

export type TwoFactorWriteSite = {
  /** Stable identity: file, enclosing symbol chain, ordinal among its peers. */
  id: string;
  file: string;
  line: number;
  /** `member.update{totpSecret,twoFactorEnabled}` or `twoFactorRecoveryCode.createMany`. */
  statement: string;
};

export type TwoFactorSecretCensus = {
  sites: TwoFactorWriteSite[];
  filesScanned: number;
};

/** Field names a payload object literal sets explicitly (keys and shorthands). */
function secretFieldsIn(payload: ts.Expression): string[] {
  const inner = unwrap(payload);
  if (!ts.isObjectLiteralExpression(inner)) return [];
  const found: string[] = [];
  for (const property of inner.properties) {
    const name =
      ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
        ? propertyName(property.name)
        : ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : null;
    if (name !== null && SECRET_FIELD_SET.has(name)) found.push(name);
  }
  return found;
}

/** The delegate name a `<receiver>.<delegate>.<method>` call is made on. */
function delegateName(receiver: ts.Expression): string | null {
  const inner = unwrap(receiver);
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isIdentifier(inner)) return inner.text;
  return null;
}

function scanFile(file: string, repoRoot: string): TwoFactorWriteSite[] {
  const relativePath = toPosix(relative(repoRoot, file));
  const ast = parseSourceFile(file);
  const sites: TwoFactorWriteSite[] = [];
  const ordinals = new Map<string, number>();
  const nextId = (symbol: string) => {
    const seen = ordinals.get(symbol) ?? 0;
    ordinals.set(symbol, seen + 1);
    return `${relativePath}::${symbol}#${seen}`;
  };

  eachNode(ast, (node) => {
    if (!ts.isCallExpression(node) || isDeclarationName(node)) return;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const delegate = delegateName(callee.expression);
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const symbol = symbolChain(node);

    if (delegate === RECOVERY_CODE_DELEGATE && !READ_METHODS.has(method)) {
      sites.push({
        id: nextId(symbol),
        file: relativePath,
        line,
        statement: `${RECOVERY_CODE_DELEGATE}.${method}`,
      });
      return;
    }

    if (!WRITE_METHODS.has(method)) return;
    const params = node.arguments[0] ? unwrap(node.arguments[0]) : null;
    if (!params || !ts.isObjectLiteralExpression(params)) return;
    const fields = new Set<string>();
    for (const property of params.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      if (key === null || !PAYLOAD_KEYS.has(key)) continue;
      for (const field of secretFieldsIn(property.initializer)) fields.add(field);
    }
    if (fields.size === 0) return;
    sites.push({
      id: nextId(symbol),
      file: relativePath,
      line,
      statement: `${delegate ?? "?"}.${method}{${[...fields].sort().join(",")}}`,
    });
  });

  return sites;
}

export function scanTwoFactorSecretCensus(
  repoRoot: string = process.cwd(),
): TwoFactorSecretCensus {
  const sites: TwoFactorWriteSite[] = [];
  let filesScanned = 0;
  for (const root of SCAN_ROOTS) {
    let files: string[] = [];
    try {
      files = listSourceFiles(join(repoRoot, root), [], SKIP_DIRECTORIES);
    } catch {
      continue;
    }
    for (const file of files) {
      filesScanned += 1;
      sites.push(...scanFile(file, repoRoot));
    }
  }
  sites.sort((a, b) => a.id.localeCompare(b.id));
  return { sites, filesScanned };
}

function main(): void {
  const census = scanTwoFactorSecretCensus();
  for (const site of census.sites) {
    process.stdout.write(`${site.id}\t${site.line}\t${site.statement}\n`);
  }
  process.stdout.write(
    `\n# files scanned: ${census.filesScanned}\n# write sites: ${census.sites.length}\n`,
  );
}

if (process.argv[1] && /two-factor-secret-census\.ts$/.test(process.argv[1])) {
  main();
}
